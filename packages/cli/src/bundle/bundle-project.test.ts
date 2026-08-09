import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requireAgentCapability } from "@skein-js/agent-protocol";
import { buildRuntime } from "@skein-js/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertEveryImportIsPinned,
  bundleProject,
  packageNameOf,
  type BuildArtifact,
  type BundleResult,
} from "./bundle-project.js";

// A committed mini-monorepo fixture: an app whose graph imports a workspace lib through a
// `tsconfig.base.json` path alias (`@fixture/lib`) plus real npm-shaped deps. This is the exact shape
// `skein build` must get right — inline the aliased source, externalize published deps, and **pin
// every one of them**. One bundle drives both the structural assertions and an end-to-end run of the
// compiled JS.
const appDir = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "__fixtures__/monorepo/apps/app",
);
const libDir = path.resolve(appDir, "../../libs/lib");
const outDir = path.join(appDir, ".skein", "build");
const artifactConfig = path.join(outDir, "langgraph.json");

/** Published-shaped ESM packages, written at setup because `node_modules` is gitignored. */
const FIXTURE_PACKAGES = {
  "@fixture/pinned": { version: "1.2.3", source: 'export const marker = "pinned-dep";\n' },
  "@fixture/lib-dep": { version: "4.5.6", source: 'export const libMarker = "lib-dep";\n' },
  "@fixture/by-name": { version: "7.8.9", source: "export const loadedByName = true;\n" },
} as const;

async function installPackage(treeDir: string, name: keyof typeof FIXTURE_PACKAGES): Promise<void> {
  const { version, source } = FIXTURE_PACKAGES[name];
  const dir = path.join(treeDir, "node_modules", ...name.split("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version, type: "module", main: "index.js" }),
  );
  await writeFile(path.join(dir, "index.js"), source);
}

// Each package is placed deliberately:
//  • `@fixture/pinned` sits next to the **app** and is imported by the graph. It is named nowhere in
//    `langgraph.json`, so the bundler's externals recorder is its only route into the artifact.
//  • `@fixture/lib-dep` sits next to the **lib** and nowhere above it — the pnpm-strict shape, where
//    resolving from the app's directory cannot see it.
//  • `@fixture/by-name` is never imported; it only appears in `langgraph.json` `dependencies`, the
//    escape hatch for packages loaded by name at runtime.
beforeAll(async () => {
  await Promise.all([
    installPackage(appDir, "@fixture/pinned"),
    installPackage(libDir, "@fixture/lib-dep"),
    installPackage(appDir, "@fixture/by-name"),
  ]);
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

// The image's install step in miniature. The Dockerfile does `COPY package.json` + `npm install`
// into /app *before* copying the bundle, so every pinned dependency lands in a `node_modules` beside
// the artifact — which is the only reason a lib-level dependency is reachable from bundled graph
// code that now sits two directories away from the lib that imported it.
beforeAll(async () => {
  await Promise.all([
    installPackage(outDir, "@fixture/pinned"),
    installPackage(outDir, "@fixture/lib-dep"),
  ]);
});

afterAll(async () => {
  await rm(path.join(appDir, ".skein"), { recursive: true, force: true });
  await rm(path.join(appDir, "node_modules"), { recursive: true, force: true });
  await rm(path.join(libDir, "node_modules"), { recursive: true, force: true });
});

/** Every bare specifier the emitted JS still imports, read straight off the files in the artifact. */
async function bareImportsInArtifact(): Promise<string[]> {
  const entries = await readdir(outDir, { recursive: true, withFileTypes: true });
  const specifiers = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    // Skip the simulated install — only the bundle's own output describes the artifact's imports.
    if (entry.parentPath.includes("node_modules")) continue;
    const code = await readFile(path.join(entry.parentPath, entry.name), "utf8");
    for (const [, specifier] of code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      if (!specifier || specifier.startsWith(".") || specifier.startsWith("#")) continue;
      // `isBuiltin`, not a `node:` prefix check: rolldown's CJS interop emits bare `fs`/`crypto` too,
      // and treating those as unpinned packages would fail this suite for no reason.
      if (isBuiltin(specifier) || specifier.startsWith("node:")) continue;
      specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

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

  it("pins a package discovered from a graph import alone", () => {
    // `@fixture/pinned` is not a skein runtime peer and is named nowhere in `langgraph.json`, so the
    // bundler's externals recorder is the only thing that can put it here. It was empty until the
    // recorder's vite plugin moved ahead of vite's core resolver (issue #6): the artifact installed
    // nothing the graphs import, and the image died on `ERR_MODULE_NOT_FOUND`.
    expect(artifact.externals["@fixture/pinned"]).toBe("1.2.3");
  });

  it("pins a dependency of an inlined workspace lib, invisible from the app", () => {
    // `@fixture/lib-dep` is installed next to `libs/lib` and nowhere above it, so resolving from the
    // project directory alone cannot find it — pnpm's strict layout, where a lib's dependency is
    // declared on the lib. Version resolution has to start at the importing file.
    expect(artifact.externals["@fixture/lib-dep"]).toBe("4.5.6");
  });

  it("pins a `langgraph.json` dependency the bundle never imports", () => {
    // The escape hatch for packages loaded by name at runtime, which no bundler can discover.
    expect(artifact.externals["@fixture/by-name"]).toBe("7.8.9");
    // A local-path entry is the project's own source, already bundled — never a pinned dependency.
    // Checked as a key rather than with `toHaveProperty`, which reads "." as a nested path separator.
    expect(Object.keys(artifact.externals)).not.toContain(".");
  });

  it("pins every package the emitted bundle still imports", async () => {
    // The image's compatibility probe in one assertion: anything the artifact imports but does not
    // install fails `node --input-type=module -e "import(...)"` inside `docker build`. Read from the
    // emitted files rather than from the build's metadata, so it stays independent of the recorder.
    const imported = await bareImportsInArtifact();
    expect(imported).toContain("@fixture/pinned");
    expect(imported).toContain("@fixture/lib-dep");

    const pinned = Object.keys(artifact.externals);
    expect(imported.map(packageNameOf).filter((pkg) => !pinned.includes(pkg))).toEqual([]);
  });

  it("writes a production manifest, precomputed schemas, and a pinned package.json", async () => {
    const manifest = JSON.parse(await readFile(artifactConfig, "utf8")) as {
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
    expect(pkg.dependencies["@fixture/pinned"]).toBe("1.2.3");
  });

  it("runs the bundled graph via nativeImport (the `skein start` boot path)", async () => {
    const schemas = JSON.parse(await readFile(path.join(outDir, "schemas.json"), "utf8")) as Record<
      string,
      never
    >;
    // No importModule → graphs load through native import() of the compiled JS, exactly as in the
    // production image. The aliased lib was inlined at build time and both externals resolve from the
    // node_modules trees around the artifact, so a correct output proves bundling *and* execution.
    const runtime = await buildRuntime({
      configPath: artifactConfig,
      store: "memory",
      queue: "memory",
      schemas,
    });
    try {
      const resolved = await runtime.deps.graphs.load("agent");
      const loaded = typeof resolved === "function" ? await resolved({}) : resolved;
      // `invoke` is optional on `AgentGraph` (a non-LangGraph agent need not implement it); a bundled
      // LangGraph graph always has it, so narrow rather than assert.
      const graph = requireAgentCapability(loaded, "invoke");
      const result = (await graph.invoke({ messages: [{ role: "user", content: "hi" }] })) as {
        messages: Array<{ content: unknown }>;
      };
      expect(result.messages.at(-1)?.content).toBe(
        "from-aliased-workspace-lib(lib-dep)+pinned-dep: hi",
      );

      // Schemas come from the baked map (the artifact ships no `.ts` to parse).
      expect(await runtime.deps.graphs.schemas("agent")).toBeDefined();
    } finally {
      await runtime.dispose();
    }
  }, 30_000);
});

/** A minimal stand-in for the rolldown output `vite.build()` resolves to. */
function bundleWith(
  chunks: Array<{ imports?: string[]; dynamicImports?: string[] }>,
): BundleResult {
  return {
    output: chunks.map((chunk, index) => ({
      type: "chunk",
      fileName: `graphs/agent-${index}.js`,
      imports: chunk.imports ?? [],
      dynamicImports: chunk.dynamicImports ?? [],
    })),
  } as unknown as BundleResult;
}

// The artifact's last line of defence, unit-tested against synthetic output. Whatever the resolver
// recorded, the *emitted* bundle is what the image runs, and every bare package it still imports has
// to be installed there — the check nothing performed when issue #6 shipped.
describe("assertEveryImportIsPinned", () => {
  it("passes when every imported package is pinned", () => {
    expect(() =>
      assertEveryImportIsPinned(bundleWith([{ imports: ["@langchain/langgraph", "zod"] }]), {
        "@langchain/langgraph": "1.4.7",
        zod: "3.25.32",
      }),
    ).not.toThrow();
  });

  it("names every unpinned package, statically and dynamically imported alike", () => {
    expect(() =>
      assertEveryImportIsPinned(
        bundleWith([{ imports: ["date-fns"], dynamicImports: ["@myorg/reports"] }]),
        { "skein-js": "0.12.0" },
      ),
    ).toThrow(/@myorg\/reports, date-fns/);
  });

  it("matches on the package, not the subpath", () => {
    // `@langchain/core/messages` is satisfied by a pin of `@langchain/core`.
    expect(() =>
      assertEveryImportIsPinned(bundleWith([{ imports: ["@langchain/core/messages"] }]), {
        "@langchain/core": "1.2.2",
      }),
    ).not.toThrow();
  });

  it("ignores builtins and sibling chunks", () => {
    // Rolldown lists emitted chunk filenames alongside externals, and a builtin needs no install.
    expect(() =>
      assertEveryImportIsPinned(
        bundleWith([
          { imports: ["node:fs", "crypto", "./chunks/shared-abc.js", "graphs/agent-1.js"] },
          {},
        ]),
        {},
      ),
    ).not.toThrow();
  });

  it("fails closed when there is no output to inspect", () => {
    // A check that passes because it found nothing to look at is worth less than no check — that is
    // the state issue #6 shipped in. Every real build emits at least one graph chunk.
    expect(() => assertEveryImportIsPinned(bundleWith([]), {})).toThrow(/no inspectable chunks/);
  });
});
