// `skein start` — serve a pre-built `.skein/build` artifact. This is the container entrypoint for the
// production image (`skein build`/`up`): plain compiled JS, no vite, no reload, no `.skein` snapshot.
// Graphs load through native `import()` (no `importModule`), and schemas come from the artifact's
// baked `schemas.json`, so the runtime never touches TypeScript or the schema worker. It shares the
// engine + graceful-shutdown shape with `skein dev`; only the dev machinery is gone.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadConfig, type GraphSchemas } from "@skein-js/config";
import { createExpressServer, type SkeinExpressServer } from "@skein-js/express";
import {
  buildRuntime,
  type QueueDriver,
  type SkeinRuntime,
  type StoreDriver,
} from "@skein-js/runtime";
import { resolveRunConcurrency, resolveShutdownGraceMs } from "@skein-js/server-kit";

import { printBanner } from "./banner.js";
import { describeError } from "./describe-error.js";
import { createDevLogger } from "./dev-logger.js";
import { applyProjectEnv } from "./project-env.js";
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
  /** Protocol-resource + checkpoint store: `"memory"` or `"postgres"` (`POSTGRES_URI`). */
  store: StoreDriver;
  /** Run queue + stream bus: `"memory"` or `"redis"` (`REDIS_URI`). */
  queue: QueueDriver;
  /** `--concurrency`: queued runs the background worker executes at once. Unset → env → default. */
  concurrency?: number;
  /** `--n-jobs-per-worker` / `-n`: the LangGraph spelling; used only when `--concurrency` is absent. */
  nJobsPerWorker?: number;
  /** `true` when `--verbose` was passed: log per-run activity. */
  verbose?: boolean;
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

  // Take a signal disposition *before* the boot, not after it. In the production image node is PID
  // 1, and the kernel silently discards signals with default disposition for PID 1 — so with no
  // listener installed, a stop arriving during boot (migrations, checkpointer setup, graph warming:
  // ~20s) would be dropped entirely and the platform would have to SIGKILL. Nothing is draining yet
  // at this point, so the boot-time handler just exits; `handleSignal` is swapped for the real
  // graceful one once the server is listening.
  let handleSignal = (): void => process.exit(0);
  process.on("SIGINT", () => handleSignal());
  process.on("SIGTERM", () => handleSignal());

  let schemas: Record<string, GraphSchemas>;
  let configDir: string;
  let authPath: string | undefined;
  let runConcurrency: number;
  let shutdownGraceMs: number;
  try {
    const loaded = await loadConfig({ configPath });
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
    });
  } catch (error) {
    console.error(`skein: ${describeError(error)}`);
    process.exitCode = 1;
    return;
  }
  // The run engine's own logger — see the note in dev-command.ts. `exposeErrorStacks` stays off
  // here: production logs the full stack, but never puts it on the wire.
  runtime.deps.logger = logger;
  if (options.verbose) runtime.deps.logRunActivity = true;

  const port = options.portExplicit ? options.port : envPort(options.port);
  const host = options.hostExplicit ? options.host : envHost(options.host);

  let server: SkeinExpressServer;
  try {
    server = await createExpressServer({
      deps: runtime.deps,
      cors: runtime.cors,
      warm: true,
      logger,
      worker: { maxConcurrency: runConcurrency, shutdownGraceMs },
    });
    await server.listen(port, host);
  } catch (error) {
    // Match `skein dev`: close the worker on a bind failure so the process exits instead of hanging.
    await runtime.dispose();
    console.error(`skein: ${describeBindError(error, port)}`);
    process.exitCode = 1;
    return;
  }

  printBanner({ host, port, graphIds: runtime.deps.graphs.ids, authPath, runConcurrency }, logger);

  // `server.close()` stops the worker (draining in-flight runs for `shutdownGraceMs`, then aborting
  // stragglers) before closing the HTTP server, so the force-exit timer has to outlast that window.
  // Dispose *after* it resolves, never alongside it: disposing tears down the Postgres pools and the
  // Redis queue the draining runs are still writing their terminal status through, so racing the two
  // strands in-flight runs at whatever status they last held.
  handleSignal = createShutdownHandler({
    forceExitMs: forceExitDelayMs(shutdownGraceMs),
    close: async () => {
      try {
        await server.close();
      } finally {
        await runtime.dispose();
      }
    },
  });
}
