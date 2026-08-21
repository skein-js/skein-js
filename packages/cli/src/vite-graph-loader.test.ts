import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createViteGraphLoader } from "./vite-graph-loader.js";

const dirs: string[] = [];
const makeTempDir = async (prefix: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createViteGraphLoader tsconfig paths", () => {
  it("resolves a graph that imports a workspace package via a tsconfig `paths` alias", async () => {
    // A minimal monorepo: a root `tsconfig.base.json` declares the `@myorg/js` alias, an app subdir
    // extends it, and the app's graph imports the aliased lib source (which lives outside the app).
    // `pnpm-workspace.yaml` at the root is what vite's `searchForWorkspaceRoot` keys on, so the
    // file-serving allowlist reaches the out-of-app lib source.
    const root = await makeTempDir("skein-monorepo-");
    await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: ['apps/*', 'libs/*']\n");
    await writeFile(
      path.join(root, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@myorg/js": ["./libs/js/src/index.ts"] } },
      }),
    );

    const libDir = path.join(root, "libs", "js", "src");
    await mkdir(libDir, { recursive: true });
    await writeFile(path.join(libDir, "index.ts"), "export const foo = 'from-aliased-lib';\n");

    const appDir = path.join(root, "apps", "app");
    await mkdir(path.join(appDir, "src"), { recursive: true });
    await writeFile(
      path.join(appDir, "tsconfig.json"),
      JSON.stringify({ extends: "../../tsconfig.base.json" }),
    );
    const graphFile = path.join(appDir, "src", "graph.ts");
    await writeFile(graphFile, "import { foo } from '@myorg/js';\nexport const graph = foo;\n");

    const loader = await createViteGraphLoader(appDir);
    try {
      const module = await loader.importModule(graphFile);
      expect(module["graph"]).toBe("from-aliased-lib");
    } finally {
      await loader.close();
    }
  });
});

describe("createViteGraphLoader env files", () => {
  // vite restarts its dev server whenever a `.env` it owns changes. In middleware mode that swaps
  // `server.environments.ssr` out from under the module runner we hold, so the next import hangs
  // until vite's 60s transport timeout — editing `.env` wedged `skein dev` entirely. skein applies
  // env itself (`applyProjectEnv`), so vite's copy was never the one graphs read.
  it("keeps serving graphs after the project's .env changes", async () => {
    const root = await makeTempDir("skein-envfile-");
    await writeFile(path.join(root, ".env"), "SOME_KEY=before\n");
    await writeFile(path.join(root, "graph.ts"), "export const graph = { id: 'ok' } as const;\n");

    const loader = await createViteGraphLoader(root);
    try {
      expect(await loader.importModule(path.join(root, "graph.ts"))).toHaveProperty("graph");

      await writeFile(path.join(root, ".env"), "SOME_KEY=after\nGOOGLE_API_KEY=filled-in\n");
      // Long enough for a restart to have been triggered and to have torn the runner down.
      await new Promise((resolve) => setTimeout(resolve, 500));

      loader.clearCache();
      const reloaded = await loader.importModule(path.join(root, "graph.ts"));
      expect(reloaded).toHaveProperty("graph");
    } finally {
      await loader.close();
    }
  }, 30_000);
});
