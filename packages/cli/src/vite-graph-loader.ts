// The in-process TypeScript loader for `skein dev`. vite (via its Module Runner) transforms and
// evaluates the project's `.ts` graph modules in this same process — no child process, no separate
// TS loader — and its file watcher drives hot reload. We expose an `importModule` matching
// `@skein-js/config`'s `ModuleImporter`, so graph loading is routed through vite instead of Node's
// native `import()` (which vite deliberately does not hook).

import { createServer as createNetServer } from "node:net";

import type { ModuleImporter } from "@skein-js/config";
import type { ViteDevServer } from "vite";
import type { ModuleRunner } from "vite/module-runner";

// vite is an optionalDependency and only used on the host (`skein dev`/`skein build`), never in the
// production image. Import it lazily so the CLI module graph loads without vite present — `skein
// start` in the slim image pulls in this file transitively but never calls into it.

/** Ask the OS for an unused TCP port. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address !== null && typeof address !== "string" ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

export interface ViteGraphLoader {
  /** Import a graph module by absolute path, transformed + evaluated through vite. */
  importModule: ModuleImporter;
  /** vite's file watcher — attach a `change` listener to drive hot reload. */
  watcher: ViteDevServer["watcher"];
  /** Drop all evaluated modules so the next `importModule` re-transforms from disk (reload). */
  clearCache(): void;
  /** Tear down the runner and the vite dev server. */
  close(): Promise<void>;
  /**
   * The workspace root vite resolved for file serving — the outermost directory a transformed module
   * can legitimately come from. The dev logger bounds its code frame to this, so an aliased lib above
   * the project dir still gets a frame while nothing outside the workspace is ever read.
   */
  workspaceRoot: string;
}

/**
 * Start a vite dev server in middleware mode (it never binds a port — it only transforms and
 * watches) plus an in-process module runner. `configFile: false` keeps loading predictable and
 * independent of any user `vite.config`; esbuild handles TypeScript out of the box. We still turn on
 * vite's native tsconfig `paths` resolution (`resolve.tsconfigPaths`), so graphs that import
 * workspace packages through path aliases (e.g. `@myorg/js`, the standard Nx/Turborepo/pnpm-workspace
 * pattern) resolve the same way they do under `langgraph dev` and `tsc`. `ignored` adds
 * watch-ignore globs on top of vite's defaults —
 * `skein dev` uses it to exclude its own `.skein/` state dir, whose periodic writes would otherwise
 * trigger an endless reload loop.
 */
export async function createViteGraphLoader(
  root: string,
  ignored: string[] = [],
): Promise<ViteGraphLoader> {
  const { createServer, createServerModuleRunner, searchForWorkspaceRoot } = await import("vite");

  // Aliased lib sources live at the monorepo root, not the app-level `root` (the `langgraph.json`
  // dir). Reuse vite's own workspace-root detection (pnpm-workspace.yaml / lerna.json / a
  // `workspaces` package.json) so the file-serving allowlist matches what vite would pick by default.
  const workspaceRoot = searchForWorkspaceRoot(root);
  const server: ViteDevServer = await createServer({
    root,
    configFile: false,
    // Resolve tsconfig `paths` natively (vite 8+): vite reads the project's tsconfig, follows
    // `extends` to a base tsconfig (e.g. `tsconfig.base.json`), and honors `baseUrl` + wildcard
    // aliases — so graphs that import workspace packages through path aliases resolve.
    resolve: { tsconfigPaths: true },
    appType: "custom",
    logLevel: "warn",
    server: {
      middlewareMode: true,
      // We drive reloads manually, so vite's HMR WebSocket server is unused. In middleware mode vite
      // binds it anyway (ignoring `hmr: false`) on a fixed default port, which collides — with a red
      // "port 24678 already in use" error — when two `skein dev`s run at once. Give it an ephemeral
      // port so instances never clash.
      hmr: { port: await findFreePort() },
      watch: { ignored: ["**/node_modules/**", "**/.git/**", "**/dist/**", ...ignored] },
      // Aliased lib sources resolve outside the app `root` (e.g. `../../libs/**`). Widen vite's
      // file-serving allowlist to the workspace root so the module runner can transform them.
      fs: { allow: [workspaceRoot] },
    },
    optimizeDeps: { noDiscovery: true },
  });
  const runner: ModuleRunner = createServerModuleRunner(server.environments.ssr, { hmr: false });

  return {
    importModule: (sourceFile) => runner.import(sourceFile) as Promise<Record<string, unknown>>,
    watcher: server.watcher,
    workspaceRoot,
    clearCache: () => runner.clearCache(),
    close: async () => {
      await runner.close();
      await server.close();
    },
  };
}
