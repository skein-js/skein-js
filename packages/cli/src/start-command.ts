// `skein start` — serve a pre-built `.skein/build` artifact. This is the container entrypoint for the
// production image (`skein build`/`up`): plain compiled JS, no vite, no reload, no `.skein` snapshot.
// Graphs load through native `import()` (no `importModule`), and schemas come from the artifact's
// baked `schemas.json`, so the runtime never touches TypeScript or the schema worker. It shares the
// engine + graceful-shutdown shape with `skein dev`; only the dev machinery is gone.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadConfig, type GraphSchemas, type SkeinRuntimeName } from "@skein-js/config";
import {
  buildRuntime,
  postgresConnectionOptions,
  type QueueDriver,
  type SkeinRuntime,
  type StoreDriver,
} from "@skein-js/runtime";
import {
  checkHeapHeadroom,
  detectRuntimeCapabilities,
  describeError,
  describePoolPressure,
  resolveRunConcurrency,
  resolveShutdownGraceMs,
} from "@skein-js/server-kit";

import { printBanner } from "./banner.js";
import { skeinCliVersion } from "./cli-version.js";
import { createDevLogger } from "./dev-logger.js";
import { applyProjectEnv } from "./project-env.js";
import { resolveRequestLog } from "./request-log.js";
import { resolveRuntimeSelection } from "./runtime-selection.js";
import { describeBindError, envHost, envPort } from "./serve-env.js";
import { createShutdownHandler, forceExitDelayMs } from "./shutdown.js";

/** The flags `skein start` accepts, after commander parsing. */
export interface StartCommandOptions {
  /** Path to the artifact's `langgraph.json` (defaults to `langgraph.json` in the cwd). */
  config: string;
  port: number;
  host: string;
  /** `true` when `--port` was passed on the CLI; suppresses the `PORT` env fallback. */
  portExplicit?: boolean;
  /** `true` when `--host` was passed on the CLI; suppresses the `HOST` env fallback. */
  hostExplicit?: boolean;
  /**
   * Protocol-resource + checkpoint store. Postgres only (`POSTGRES_URI`) — narrower than `StoreDriver`
   * on purpose, since this is the production entrypoint and the flag rejects `memory` at parse time.
   */
  store: Extract<StoreDriver, "postgres">;
  /** Run queue + stream bus. Redis only (`REDIS_URI`), for the same reason as `store`. */
  queue: Extract<QueueDriver, "redis">;
  /** `--concurrency`: queued runs the background worker executes at once. Unset → env → default. */
  concurrency?: number;
  /** `--n-jobs-per-worker` / `-n`: the LangGraph spelling; used only when `--concurrency` is absent. */
  nJobsPerWorker?: number;
  /** `true` when `--verbose` was passed: log per-run activity. */
  verbose?: boolean;
  /** `--run-timeout`: abort a run executing longer than this (ms). Unset → env → no timeout. */
  runTimeout?: number;
  /** `--request-log`: a line per HTTP request. Unset → `SKEIN_REQUEST_LOG` → off for `start`. */
  requestLog?: boolean;
  /** CLI override for `skein.runtime.name`. */
  runtime?: SkeinRuntimeName;
  /** CLI override for `skein.runtime.version` (recorded for precedence consistency). */
  runtimeVersion?: string;
}

interface ProductionServer {
  close: () => Promise<void>;
}

/** Load the artifact's precomputed schemas (baked by `skein build`), keyed by graph id. */
function readBakedSchemas(configDir: string): Record<string, GraphSchemas> {
  const schemasFile = path.join(configDir, "schemas.json");
  if (!existsSync(schemasFile)) {
    throw new Error(
      `no schemas.json next to the config — \`skein start\` expects a built artifact. ` +
        `Run \`skein build\` (or \`skein up\`), or use \`skein dev\` for a source project.`,
    );
  }
  return JSON.parse(readFileSync(schemasFile, "utf8")) as Record<string, GraphSchemas>;
}

export async function runStart(options: StartCommandOptions): Promise<void> {
  const configPath = path.resolve(process.cwd(), options.config);
  const capabilities = detectRuntimeCapabilities();

  // Take a signal disposition *before* the boot, not after it. In the production image node is PID
  // 1, and the kernel silently discards signals with default disposition for PID 1 — so with no
  // listener installed, a stop arriving during boot (migrations, checkpointer setup, graph warming:
  // ~20s) would be dropped entirely and the platform would have to SIGKILL. Nothing is draining yet
  // at this point, so the boot-time handler just exits; `handleSignal` is swapped for the real
  // graceful one once the server is listening.
  let handleSignal = (): void => capabilities.exit(0);
  capabilities.signals.on("SIGINT", () => handleSignal());
  capabilities.signals.on("SIGTERM", () => handleSignal());

  let schemas: Record<string, GraphSchemas>;
  let configDir: string;
  let authPath: string | undefined;
  let runConcurrency: number;
  let shutdownGraceMs: number;
  let selectedRuntime: SkeinRuntimeName;
  try {
    const loaded = await loadConfig({ configPath });
    const runtimeSelection = resolveRuntimeSelection(loaded.config, options);
    selectedRuntime = runtimeSelection.name;
    // `capabilities.name` rather than a second hand-rolled detection: two sources of truth for the
    // same fact can disagree, and then this guard validates the wrong one.
    const actualRuntime = capabilities.name;
    if (actualRuntime !== selectedRuntime) {
      throw new Error(
        `artifact selected runtime ${selectedRuntime}, but it was launched with ${actualRuntime}. ` +
          `Use the generated image command or pass --runtime ${actualRuntime}.`,
      );
    }
    configDir = loaded.configDir;
    authPath = loaded.config.auth?.path;
    // Apply an inline `env` map baked into the production config (a file `env` was dropped at build).
    await applyProjectEnv(loaded.config, configDir);
    // Flag → LangGraph-compat alias → SKEIN_RUN_CONCURRENCY → N_JOBS_PER_WORKER → default. Inside this
    // block so a bad value prints `skein: …` and exits 1, like every other boot-config failure.
    runConcurrency = resolveRunConcurrency(options.concurrency ?? options.nJobsPerWorker);
    // Same treatment for SKEIN_SHUTDOWN_GRACE_MS: resolved up front so a bad value fails the boot
    // rather than surfacing only once the platform sends SIGTERM.
    shutdownGraceMs = resolveShutdownGraceMs();
    schemas = readBakedSchemas(configDir);
  } catch (error) {
    console.error(`skein: ${describeError(error)}`);
    process.exitCode = 1;
    return;
  }

  // The console logger, once the project root is known. Its failure-block code frame is bounded to
  // that root: an error message can be attacker-influenced, and a frame is only ever useful for the
  // deployment's own source. In a production image the bundled artifact usually has no original
  // sources at all, so the frame is simply omitted and the stack still prints.
  const logger = createDevLogger({ sourceRoot: configDir });

  // No `importModule`: graphs load via native `import()` of the bundled JS. `schemas` short-circuits
  // schema introspection to the baked map, so the runtime never parses TypeScript. Guarded because a
  // bad POSTGRES_URI/REDIS_URI or a throwing graph import must surface as a clean error + exit 1, not
  // an unhandled rejection (buildRuntime tears down any partial resources itself before rejecting).
  let runtime: SkeinRuntime;
  try {
    runtime = await buildRuntime({
      configPath,
      store: options.store,
      queue: options.queue,
      schemas,
      // The CLI knows its own version and the engine deliberately does not — see cli-version.ts.
      serverVersion: skeinCliVersion(),
    });
  } catch (error) {
    console.error(`skein: ${describeError(error)}`);
    process.exitCode = 1;
    return;
  }
  // `exposeErrorStacks` stays off here: production logs the full stack (the adapter's `logger`
  // option below reaches the run engine), but never puts it on the wire.
  if (options.verbose) runtime.deps.logRunActivity = true;
  // Set on the deps rather than passed to the adapter: `runTimeoutMs` is a run-engine setting, and the
  // engine reads it from the deps. `resolveProtocolRuntime` fills it from the environment when unset.
  if (options.runTimeout !== undefined) runtime.deps.runTimeoutMs = options.runTimeout;

  const port = options.portExplicit ? options.port : envPort(options.port);
  const host = options.hostExplicit ? options.host : envHost(options.host);

  let server: ProductionServer | undefined;
  try {
    const sharedOptions = {
      deps: runtime.deps,
      cors: runtime.cors,
      warm: true,
      logger,
      worker: { maxConcurrency: runConcurrency, shutdownGraceMs },
    } as const;
    // Resolved on every runtime, not just the branch that can honour it: `resolveRequestLog` is what
    // validates `SKEIN_REQUEST_LOG`, and every sibling resolver in this codebase reads the environment
    // whether or not an explicit value wins, so a typo fails at boot instead of sitting unnoticed.
    const requestLog = resolveRequestLog(options.requestLog, false);
    if (selectedRuntime === "node") {
      // Loaded only on Node. Bun/Deno production artifacts never import Express or Node's HTTP shim.
      const { createExpressServer } = await import("@skein-js/express");
      const expressServer = await createExpressServer({
        ...sharedOptions,
        requestLog,
      });
      server = expressServer;
      await expressServer.listen(port, host);
    } else {
      if (requestLog) {
        logger.warn?.(
          `skein: --request-log / SKEIN_REQUEST_LOG is ignored on ${selectedRuntime}: the native ` +
            `Fetch transport has no request-logging middleware. Failed runs are still reported.`,
        );
      }
      const { createSkeinFetchServer, startBunServer, startDenoServer } =
        await import("@skein-js/fetch");
      const fetchServer = await createSkeinFetchServer(sharedOptions);
      // Install a teardown immediately: native bind can throw synchronously after the worker starts.
      server = { close: fetchServer.close };
      if (selectedRuntime === "bun") {
        const listener = startBunServer(fetchServer.fetch, { port, hostname: host });
        server = {
          close: async () => {
            listener.stop(false);
            await fetchServer.close();
          },
        };
      } else {
        const listener = startDenoServer(fetchServer.fetch, { port, hostname: host });
        server = {
          close: async () => {
            // Initiate listener shutdown first so no new requests enter, then let the worker finish
            // active streams before waiting for Deno's listener to report every connection closed.
            const listenerClosed = listener.shutdown();
            const [workerResult, listenerResult] = await Promise.allSettled([
              fetchServer.close(),
              listenerClosed,
            ]);
            if (workerResult.status === "rejected") throw workerResult.reason;
            if (listenerResult.status === "rejected") throw listenerResult.reason;
          },
        };
      }
    }
  } catch (error) {
    // A listener can fail after its protocol worker has started. Drain it before disposing the
    // Postgres/Redis drivers it still needs to persist terminal state.
    try {
      await server?.close();
    } catch (cleanupError) {
      console.error(`skein: startup cleanup failed: ${describeError(cleanupError)}`);
    } finally {
      await runtime.dispose();
    }
    console.error(`skein: ${describeBindError(error, port)}`);
    process.exitCode = 1;
    return;
  }

  printBanner({ host, port, graphIds: runtime.deps.graphs.ids, authPath, runConcurrency }, logger);

  // Two sizing mistakes that are already true before any traffic arrives, and that otherwise only show
  // up as symptoms much later: an unexplained restart (OOM kill), and requests queuing on the pool.
  // Reported once, after the banner, so they read as part of the startup summary.
  if (capabilities.name === "node") {
    const { warning: heapWarning } = checkHeapHeadroom();
    if (heapWarning) logger.warn?.(`skein: ${heapWarning}`);
  } else {
    // Only the BOOT-TIME sizing check is Node-specific: its remedy is `--max-old-space-size`, a V8
    // flag, and its threshold is calibrated against V8's cgroup-derived ceiling. The ongoing
    // heap-pressure monitor runs on every runtime — `node:v8`'s `getHeapStatistics()` answers under
    // Bun (JavaScriptCore's ceiling) and Deno alike — so say which one is unavailable, or an operator
    // reads this as "no OOM early warning" and stops watching for the line that does still arrive.
    logger.info?.(
      `skein: ${capabilities.name} ${capabilities.version}; boot-time heap sizing advice is ` +
        `Node-specific and skipped. Runtime heap-pressure warnings remain active ` +
        `(SKEIN_HEAP_WARN_PERCENT).`,
    );
  }

  const poolWarning = describePoolPressure(runConcurrency, postgresConnectionOptions().poolMax);
  if (poolWarning) logger.warn?.(`skein: ${poolWarning}`);

  // `server.close()` stops the worker (draining in-flight runs for `shutdownGraceMs`, then aborting
  // stragglers) before closing the HTTP server, so the force-exit timer has to outlast that window.
  // Dispose *after* it resolves, never alongside it: disposing tears down the Postgres pools and the
  // Redis queue the draining runs are still writing their terminal status through, so racing the two
  // strands in-flight runs at whatever status they last held.
  handleSignal = createShutdownHandler({
    forceExitMs: forceExitDelayMs(shutdownGraceMs),
    close: async () => {
      try {
        await server?.close();
      } finally {
        await runtime.dispose();
      }
    },
  });
}
