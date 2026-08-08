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
  type DevStateSnapshot,
  type SkeinExpressServer,
} from "@skein-js/express";
import { buildRuntime, type QueueDriver, type StoreDriver } from "@skein-js/runtime";
import { resolveRunConcurrency, resolveShutdownGraceMs } from "@skein-js/server-kit";
import { describeSnapshot, readLanggraphDevState } from "@skein-js/server-kit/dev";

import { printBanner } from "./banner.js";
import { skeinCliVersion } from "./cli-version.js";
import { mountConsole } from "./console-mount.js";
import { createDevLogger } from "./dev-logger.js";
import { devStateFile, LANGGRAPH_DIR, STATE_DIR, writeDevStateFile } from "./dev-state.js";
import { applyProjectEnv } from "./project-env.js";
import { resolveRequestLog } from "./request-log.js";
import { describeBindError, envHost, envPort } from "./serve-env.js";
import { createShutdownHandler, forceExitDelayMs } from "./shutdown.js";
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
  /** `--concurrency`: queued runs the background worker executes at once. Unset → env → default. */
  concurrency?: number;
  /** `--n-jobs-per-worker` / `-n`: the LangGraph spelling; used only when `--concurrency` is absent. */
  nJobsPerWorker?: number;
  /** `true` when `--verbose` was passed: log per-run activity (start/finish, tool calls, interrupts). */
  verbose?: boolean;
  /** `--run-timeout`: abort a run executing longer than this (ms). Unset → env → no timeout. */
  runTimeout?: number;
  /** `--request-log` / `--no-request-log`: a line per HTTP request. Unset → env → on for `dev`. */
  requestLog?: boolean;
  /** `false` when `--no-console` was passed. The console is served by default under `dev`. */
  console?: boolean;
}

/** Wait this long after the last change event before reloading, so a burst of saves is one reload. */
const RELOAD_DEBOUNCE_MS = 120;
/** How often to autosave dev state to disk while running. */
const AUTOSAVE_MS = 2000;

export async function runDev(options: DevCommandOptions): Promise<void> {
  const configPath = path.resolve(process.cwd(), options.config);

  // Validate + resolve env before starting anything, so a bad config fails fast and graphs see
  // their env on first load. `loadConfig` here does not import `.ts` — that happens through vite.
  const { config, configDir } = await loadConfig({ configPath });
  await applyProjectEnv(config, configDir);

  // Resolved here, before the vite loader and the runtime exist: a bad SKEIN_SHUTDOWN_GRACE_MS
  // should fail the boot with nothing yet to tear down, rather than after the Postgres pools and
  // Redis connections are already open. (`skein start` resolves it inside its boot try/catch for the
  // same reason.)
  const shutdownGraceMs = resolveShutdownGraceMs();

  const stateDir = path.join(configDir, STATE_DIR);
  const stateFile = devStateFile(configDir);

  // Ignore our own persisted-state dir: its periodic autosave writes would otherwise be seen as
  // source changes and trigger an endless reload loop.
  const loader = await createViteGraphLoader(configDir, [`${STATE_DIR}/**`, `**/${STATE_DIR}/**`]);
  // The dev server's console logger — colored, `info:`-prefixed output that drives per-request
  // logging, the background-run summaries, the startup banner, and engine warnings. Its failure-block
  // code frame is bounded to the workspace vite serves from: wide enough for an aliased lib above the
  // project dir, closed to everything else.
  const devLogger = createDevLogger({ sourceRoot: loader.workspaceRoot });
  const runtime = await buildRuntime({
    configPath,
    importModule: loader.importModule,
    store: options.store,
    queue: options.queue,
    // The CLI knows its own version and the engine deliberately does not — see cli-version.ts.
    serverVersion: skeinCliVersion(),
  });
  // Fall back to PORT/HOST env only when the flag wasn't passed explicitly (so an explicit --port
  // always wins). Resolved after applyProjectEnv above, so a PORT in the project's .env counts.
  const port = options.portExplicit ? options.port : envPort(options.port);
  const host = options.hostExplicit ? options.host : envHost(options.host);
  // Flag → LangGraph-compat alias → SKEIN_RUN_CONCURRENCY → N_JOBS_PER_WORKER → default. Resolved
  // after applyProjectEnv above, so a value in the project's .env counts — the PORT/HOST rule.
  const runConcurrency = resolveRunConcurrency(options.concurrency ?? options.nJobsPerWorker);
  // On-disk snapshotting only applies to the all-memory runtime; durable drivers persist inherently.
  const canPersist = options.persist && runtime.snapshotState !== undefined;
  if (options.persist && runtime.snapshotState === undefined) {
    console.log(
      `skein: state persists in ${options.store}/${options.queue}; skipping .skein snapshot.`,
    );
  }
  if (canPersist && existsSync(stateFile)) {
    try {
      await runtime.hydrateState?.(JSON.parse(readFileSync(stateFile, "utf8")) as DevStateSnapshot);
      console.log("skein: restored dev state.");
    } catch (error) {
      devLogger.warn("could not restore dev state", error);
    }
  } else if (canPersist && existsSync(path.join(configDir, LANGGRAPH_DIR))) {
    // No skein state yet, but a LangGraph dev state is present — import it once so switching from
    // `langgraph dev` loses nothing. It then persists to `.skein/` on the next autosave, and this
    // branch won't run again. Guarded so a format mismatch never blocks startup.
    try {
      const imported = await readLanggraphDevState(path.join(configDir, LANGGRAPH_DIR));
      if (imported) {
        await runtime.hydrateState?.(imported);
        const counts = describeSnapshot(imported);
        console.log(
          `skein: imported dev state from ${LANGGRAPH_DIR}/ ` +
            `(${counts.threads} thread(s), ${counts.checkpointedThreads} with history).`,
        );
      }
    } catch (error) {
      devLogger.warn(`could not import ${LANGGRAPH_DIR}/`, error);
    }
  }

  // `--verbose`: have the run engine log per-run activity (start/finish, tool calls, interrupts).
  if (options.verbose) runtime.deps.logRunActivity = true;
  if (options.runTimeout !== undefined) runtime.deps.runTimeoutMs = options.runTimeout;
  // The dev server sends a failed run's stack to the client too (the `error` SSE frame and the
  // persisted `Run.error`), so a browser-side `useStream` can show it. Deliberately unconditional
  // rather than behind `--verbose`: needing a flag to find out why your graph crashed is the very
  // problem this reporting exists to remove. `skein start` leaves it off.
  runtime.deps.exposeErrorStacks = true;

  let server: SkeinExpressServer;
  let consoleMountPath: string | undefined;
  try {
    server = await createExpressServer({
      deps: runtime.deps,
      cors: runtime.cors,
      warm: true,
      logger: devLogger,
      requestLog: resolveRequestLog(options.requestLog, true),
      worker: { maxConcurrency: runConcurrency, shutdownGraceMs },
    });
    // On by default in `dev` — a local dev server is exactly where you want to see your threads and
    // runs, and asking for a flag first means most people never find it. `skein start` is the
    // opposite: the console is full API power over threads, store and crons, so a production server
    // serves it only when its config says to. See docs/console.md.
    if (options.console !== false) {
      consoleMountPath = mountConsole(server.app).mountPath;
    }
    await server.listen(port, host);
  } catch (error) {
    // `skeinRouter` starts the run worker before `listen`; without these closes a bind failure
    // leaves the worker holding the event loop open and the process hangs instead of exiting.
    await Promise.allSettled([loader.close(), runtime.dispose()]);
    console.error(`skein: ${describeBindError(error, port)}`);
    process.exitCode = 1;
    return;
  }
  printBanner(
    {
      host,
      port,
      graphIds: runtime.deps.graphs.ids,
      authPath: config.auth?.path,
      runConcurrency,
      ...(consoleMountPath ? { consoleMountPath } : {}),
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
      devLogger.warn("could not persist dev state", error);
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
              // The Error goes as meta, so the dev logger prints the stack and, for a config
              // error, the `caused by:` chain that names the real import failure.
              devLogger.error(`graph "${id}" failed to load`, error);
            }),
          ),
        );
        console.log("skein: reloaded.");
      } catch (error) {
        // A bad config (e.g. langgraph.json edited to invalid JSON) rejects reloadGraphs. Log and
        // keep the watcher alive — never let it become an unhandled rejection that kills the server.
        devLogger.error("reload failed", error);
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

  const shutdown = createShutdownHandler({
    forceExitMs: forceExitDelayMs(shutdownGraceMs),
    // Stop autosaving and flush one last snapshot synchronously, before anything can race it.
    onShutdownStart: () => {
      if (autosave) clearInterval(autosave);
      saveState();
    },
    // Strictly ordered, never concurrent. `server.close()` stops the worker, which needs the store
    // and queue still alive to settle in-flight runs terminally — and needs the vite loader alive
    // too, since a draining graph may still `await import(...)` a module it hasn't loaded yet.
    // Tearing either down alongside the drain fails the runs it was meant to save.
    close: async () => {
      try {
        await server.close();
      } finally {
        await Promise.allSettled([loader.close(), runtime.dispose()]);
      }
    },
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
