import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildRuntime } from "@skein-js/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bundleProject, type BuildArtifact } from "./bundle-project.js";

// A committed mini-monorepo fixture: an app whose graph imports a workspace lib through a
// `tsconfig.base.json` path alias (`@fixture/lib`) plus a real npm dep (`@langchain/langgraph`). This
// is the exact shape `skein build` must get right — inline the aliased source, externalize published
// deps. One bundle drives both the structural assertions and an end-to-end run of the compiled JS.
const appDir = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "__fixtures__/monorepo/apps/app",
);
const outDir = path.join(appDir, ".skein", "build");
const artifactConfig = path.join(outDir, "langgraph.json");

// A dependency installed next to the *app* and nowhere above it. Version pinning has to resolve from
// the project, so this is the one case a fixture nested inside `packages/cli` can still prove: the
// walk-up from the workspace root cannot reach it. Written at setup because node_modules is gitignored.
const pinnedDepDir = path.join(appDir, "node_modules", "@fixture", "pinned");

beforeAll(async () => {
  await mkdir(pinnedDepDir, { recursive: true });
  await writeFile(
    path.join(pinnedDepDir, "package.json"),
    JSON.stringify({ name: "@fixture/pinned", version: "1.2.3", main: "index.js" }),
  );
  await writeFile(path.join(pinnedDepDir, "index.js"), "export const pinned = true;\n");
});

let artifact: BuildArtifact;

beforeAll(async () => {
  artifact = await bundleProject({
    configPath: path.join(appDir, "langgraph.json"),
    outDir,
    nodeVersion: "20",
    skeinVersion: "9.9.9-test",
  });
}, 60_000);

afterAll(async () => {
  await rm(path.join(appDir, ".skein"), { recursive: true, force: true });
  await rm(path.join(appDir, "node_modules"), { recursive: true, force: true });
});

describe("bundleProject", () => {
  it("inlines workspace aliases and externalizes/pins npm deps", async () => {
    expect(artifact.graphIds).toEqual(["agent"]);

    // The aliased workspace lib is inlined into the graph bundle (not an external).
    const graphJs = await readFile(path.join(outDir, "graphs/agent.js"), "utf8");
    expect(graphJs).toContain("from-aliased-workspace-lib");
    expect(artifact.externals).not.toHaveProperty("@fixture/lib");

    // Published packages are externalized and pinned to an exact version.
    expect(artifact.externals["@langchain/langgraph"]).toMatch(/^\d+\.\d+\.\d+/);

    // The runtime closure the image needs to run `skein start`.
    expect(artifact.externals["skein-js"]).toBe("9.9.9-test");
    expect(artifact.externals["@langchain/langgraph-checkpoint-postgres"]).toMatch(
      /^\d+\.\d+\.\d+/,
    );
  });

  it("pins a dependency installed next to the project, not only ones visible from the workspace root", () => {
    // Resolving from the workspace root instead fails for every project that is a package inside a
    // repo: a pnpm workspace root hoists nothing, so the app's own dependencies are invisible there.
    // Reproduced before the fix — `skein build` threw for every example in this repo.
    expect(artifact.externals["@fixture/pinned"]).toBe("1.2.3");
    // A local-path entry is the project's own source, already bundled — never a pinned dependency.
    // Checked as a key rather than with `toHaveProperty`, which reads "." as a nested path separator.
    expect(Object.keys(artifact.externals)).not.toContain(".");
  });

  it("writes a production manifest, precomputed schemas, and a pinned package.json", async () => {
    const manifest = JSON.parse(await readFile(path.join(outDir, "langgraph.json"), "utf8")) as {
      graphs: Record<string, string>;
    };
    expect(manifest.graphs.agent).toBe("./graphs/agent.js:graph");

    const schemas = JSON.parse(await readFile(path.join(outDir, "schemas.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(schemas.agent).toBeDefined();

    const pkg = JSON.parse(await readFile(path.join(outDir, "package.json"), "utf8")) as {
      private: boolean;
      dependencies: Record<string, string>;
    };
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies["skein-js"]).toBe("9.9.9-test");
  });

  it("runs the bundled graph via nativeImport (the `skein start` boot path)", async () => {
    const schemas = JSON.parse(await readFile(path.join(outDir, "schemas.json"), "utf8")) as Record<
      string,
      never
    >;
    // No importModule → graphs load through native import() of the compiled JS, exactly as in the
    // production image. The aliased lib was inlined at build time, so a correct output proves both
    // bundling and execution.
    const runtime = await buildRuntime({
      configPath: artifactConfig,
      store: "memory",
      queue: "memory",
      schemas,
    });
    try {
      const resolved = await runtime.deps.graphs.load("agent");
      const graph = typeof resolved === "function" ? await resolved({}) : resolved;
      const result = (await graph.invoke({ messages: [{ role: "user", content: "hi" }] })) as {
        messages: Array<{ content: unknown }>;
      };
      expect(result.messages.at(-1)?.content).toBe("from-aliased-workspace-lib: hi");

      // Schemas come from the baked map (the artifact ships no `.ts` to parse).
      expect(await runtime.deps.graphs.schemas("agent")).toBeDefined();
    } finally {
      await runtime.dispose();
    }
  }, 30_000);
});
