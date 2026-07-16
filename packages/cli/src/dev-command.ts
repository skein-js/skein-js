// `skein dev` — the in-process development server, a drop-in for `langgraph dev`. Everything runs
// in this single Node process: vite transforms + watches the project's TypeScript graphs (see
// vite-graph-loader.ts), and `@skein-js/express` serves the Agent Protocol over the runtime built
// by `@skein-js/runtime` — in-memory by default, or `--store postgres` / `--queue redis` to develop
// against production-shaped storage without Docker. Two things go beyond a naive dev server:
//   • Hot reload keeps state — on a source change we clear vite's cache and swap in the fresh graph
//     code, but reuse the same store/checkpointer, so threads, runs, and memories survive the reload.
//   • Persistence across restarts — dev state is snapshotted to `<project>/.skein/` and restored on
//     the next boot (mirroring how `langgraph dev` keeps local state).
// No Docker, no child process.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadConfig } from "@skein-js/config";
import {
  createExpressServer,
  describeSnapshot,
  readLanggraphDevState,
  type DevStateSnapshot,
  type SkeinExpressServer,
} from "@skein-js/express";
import { buildRuntime, type QueueDriver, type StoreDriver } from "@skein-js/runtime";

import { printBanner } from "./banner.js";
import { createDevLogger } from "./dev-logger.js";
import { devStateFile, writeDevStateFile, LANGGRAPH_DIR, STATE_DIR } from "./dev-state.js";
import { applyProjectEnv } from "./project-env.js";
import { createViteGraphLoader } from "./vite-graph-loader.js";

/** The flags `skein dev` accepts, after commander parsing. */
export interface DevCommandOptions {
  config: string;
  port: number;
  host: string;
  /** `false` when `--no-reload` was passed. */
  reload: boolean;
  /** `false` when `--no-persist` was passed. */
  persist: boolean;
  /** `true` when `--port` was passed on the CLI; suppresses the `PORT` env fallback. */
  portExplicit?: boolean;
  /** `true` when `--host` was passed on the CLI; suppresses the `HOST` env fallback. */
  hostExplicit?: boolean;
  /** Protocol-resource + checkpoint store: `"memory"` (default) or `"postgres"` (`POSTGRES_URI`). */
  store: StoreDriver;
  /** Run queue + stream bus: `"memory"` (default) or `"redis"` (`REDIS_URI`). */
  queue: QueueDriver;
  /** `true` when `--verbose` was passed: log per-run activity (start/finish, tool calls, interrupts). */
  verbose?: boolean;
}

/** Wait this long after the last change event before reloading, so a burst of saves is one reload. */
const RELOAD_DEBOUNCE_MS = 120;
/** How often to autosave dev state to disk while running. */
const AUTOSAVE_MS = 2000;
/** How long to wait for a graceful shutdown before forcing exit — an in-flight run can stall it. */
const FORCE_EXIT_MS = 5000;

/** Console logger for the dev server — colored, `info:`-prefixed output that drives per-request
 * logging, the background-run summaries, the startup banner, and surfaces engine warnings. */
const devLogger = createDevLogger();

/**
 * Port to bind, honoring a `PORT` env var (Railway/Fly/Render/Heroku inject one). Resolved here,
 * after the project's `.env` is merged, so a project-declared PORT is honored too — not just an
 * ambient one. Returns `fallback` when PORT is unset or not a valid port.
 */
function envPort(fallback: number): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw.trim() === "") return fallback;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : fallback;
}

/** Host to bind, honoring a `HOST` env var when set; otherwise `fallback`. */
function envHost(fallback: string): string {
  const host = process.env.HOST;
  return host !== undefined && host.trim() !== "" ? host : fallback;
}

export async function runDev(options: DevCommandOptions): Promise<void> {
  const configPath = path.resolve(process.cwd(), options.config);

  // Validate + resolve env before starting anything, so a bad config fails fast and graphs see
  // their env on first load. `loadConfig` here does not import `.ts` — that happens through vite.
  const { config, configDir } = await loadConfig({ configPath });
  await applyProjectEnv(config, configDir);

  const stateDir = path.join(configDir, STATE_DIR);
  const stateFile = devStateFile(configDir);

  // Ignore our own persisted-state dir: its periodic autosave writes would otherwise be seen as
  // source changes and trigger an endless reload loop.
  const loader = await createViteGraphLoader(configDir, [`${STATE_DIR}/**`, `**/${STATE_DIR}/**`]);
  const runtime = await buildRuntime({
    configPath,
    importModule: loader.importModule,
    store: options.store,
    queue: options.queue,
  });
  // Fall back to PORT/HOST env only when the flag wasn't passed explicitly (so an explicit --port
  // always wins). Resolved after applyProjectEnv above, so a PORT in the project's .env counts.
  const port = options.portExplicit ? options.port : envPort(options.port);
  const host = options.hostExplicit ? options.host : envHost(options.host);
  // On-disk snapshotting only applies to the all-memory runtime; durable drivers persist inherently.
  const canPersist = options.persist && runtime.snapshotState !== undefined;
  if (options.persist && runtime.snapshotState === undefined) {
    console.log(
      `skein: state persists in ${options.store}/${options.queue}; skipping .skein snapshot.`,
    );
  }
  if (canPersist && existsSync(stateFile)) {
    try {
      runtime.hydrateState?.(JSON.parse(readFileSync(stateFile, "utf8")) as DevStateSnapshot);
      console.log("skein: restored dev state.");
    } catch (error) {
      console.warn(
        `skein: could not restore dev state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (canPersist && existsSync(path.join(configDir, LANGGRAPH_DIR))) {
    // No skein state yet, but a LangGraph dev state is present — import it once so switching from
    // `langgraph dev` loses nothing. It then persists to `.skein/` on the next autosave, and this
    // branch won't run again. Guarded so a format mismatch never blocks startup.
    try {
      const imported = await readLanggraphDevState(path.join(configDir, LANGGRAPH_DIR));
      if (imported) {
        runtime.hydrateState?.(imported);
        const counts = describeSnapshot(imported);
        console.log(
          `skein: imported dev state from ${LANGGRAPH_DIR}/ ` +
            `(${counts.threads} thread(s), ${counts.checkpointedThreads} with history).`,
        );
      }
    } catch (error) {
      console.warn(
        `skein: could not import ${LANGGRAPH_DIR}/: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // `--verbose`: have the run engine log per-run activity (start/finish, tool calls, interrupts).
  if (options.verbose) runtime.deps.logRunActivity = true;

  let server: SkeinExpressServer;
  try {
    server = await createExpressServer({
      deps: runtime.deps,
      cors: runtime.cors,
      warm: true,
      logger: devLogger,
    });
    await server.listen(port, host);
  } catch (error) {
    // `skeinRouter` starts the run worker before `listen`; without these closes a bind failure
    // leaves the worker holding the event loop open and the process hangs instead of exiting.
    await Promise.allSettled([loader.close(), runtime.dispose()]);
    const code = (error as NodeJS.ErrnoException).code;
    console.error(
      code === "EADDRINUSE"
        ? `skein: port ${port} is already in use. Stop the other process or pass --port.`
        : `skein: failed to start dev server: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }
  printBanner(
    {
      host,
      port,
      graphIds: runtime.deps.graphs.ids,
      authPath: config.auth?.path,
      workerCount: 1,
    },
    devLogger,
  );

  let lastSaved: string | undefined;
  const saveState = () => {
    if (!canPersist || runtime.snapshotState === undefined) return;
    try {
      const serialized = JSON.stringify(runtime.snapshotState());
      if (serialized === lastSaved) return; // unchanged since the last write — skip the disk churn
      writeDevStateFile(stateFile, serialized);
      lastSaved = serialized;
    } catch (error) {
      console.warn(
        `skein: could not persist dev state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  let autosave: NodeJS.Timeout | undefined;
  if (canPersist) {
    autosave = setInterval(saveState, AUTOSAVE_MS);
    autosave.unref();
  }

  if (options.reload) {
    let reloading = false;
    let dirty = false;
    let pending: NodeJS.Timeout | undefined;
    const reload = async () => {
      // If a reload is already running, remember that more changes arrived and re-run once it's done,
      // so edits saved mid-reload are never dropped.
      if (reloading) {
        dirty = true;
        return;
      }
      reloading = true;
      try {
        console.log("skein: change detected, reloading…");
        loader.clearCache();
        await runtime.reloadGraphs();
        // Re-import graphs: surfaces errors now and re-arms vite's watcher on the fresh module graph.
        await Promise.all(
          runtime.deps.graphs.ids.map((id) =>
            runtime.deps.graphs.load(id).catch((error: unknown) => {
              console.error(`skein: graph "${id}" failed to load: ${String(error)}`);
            }),
          ),
        );
        console.log("skein: reloaded.");
      } catch (error) {
        // A bad config (e.g. langgraph.json edited to invalid JSON) rejects reloadGraphs. Log and
        // keep the watcher alive — never let it become an unhandled rejection that kills the server.
        console.error(
          `skein: reload failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        reloading = false;
        if (dirty) {
          dirty = false;
          void reload();
        }
      }
    };
    loader.watcher.on("change", (file) => {
      // Defense in depth against a self-triggered loop: never reload on our own state writes.
      if (`${path.resolve(file)}${path.sep}`.startsWith(`${stateDir}${path.sep}`)) return;
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => void reload(), RELOAD_DEBOUNCE_MS);
    });
  }

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (autosave) clearInterval(autosave);
    const forceExit = setTimeout(() => process.exit(0), FORCE_EXIT_MS);
    forceExit.unref();
    saveState();
    void Promise.allSettled([server.close(), loader.close(), runtime.dispose()]).then(() =>
      process.exit(0),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
