// The runtime-resolution step every framework adapter shares: turn a `{ config } | { deps }` option
// bag into a live `ProtocolRuntime` with assistants seeded and the background worker running. Kept
// here (not in a single adapter) so Express/Fastify/NestJS/Next.js resolve the runtime identically
// and can't drift (e.g. one forgetting `registerGraphAssistants()`). The adapter then maps the route
// table onto its own router and manages `runtime.worker.stop()` on shutdown.

import {
  createProtocolRuntime,
  skeinRoutes,
  type RunWorker,
  type Logger,
  type ProtocolDeps,
  type ProtocolRuntime,
  type RouteBinding,
  type RunWorkerOptions,
} from "@skein-js/agent-protocol";
import type { ModuleImporter } from "@skein-js/config";
import type { CorsOptions } from "cors";

import { resolveHeapPressureOptions, startHeapPressureMonitor } from "./heap-pressure.js";
import { resolveRunConcurrency } from "./run-concurrency.js";
import { resolveRunTimeoutMs } from "./run-timeout.js";
import { resolveShutdownGraceMs } from "./shutdown-grace.js";

export interface SkeinRuntimeCommonOptions {
  /**
   * Where skein reports itself: failed runs, webhook delivery failures, background-run summaries, and
   * the adapter's own transport faults. It reaches **the run engine**, not just the transport — this
   * is the one knob that decides whether a crashed graph is visible at all.
   *
   * Precedence, most explicit first:
   *
   * | You pass                 | Result                                                            |
   * | ------------------------ | ----------------------------------------------------------------- |
   * | a `Logger`               | that logger, overriding any `deps.logger`                          |
   * | `false`                  | the adapter contributes nothing and installs no default; an injected `deps.logger` still stands |
   * | nothing                  | `deps.logger` if you injected one, else the adapter's framework default |
   *
   * The framework default exists only where the framework owns a logger the host has already
   * configured: NestJS (`@nestjs/common`'s `Logger`, honoring `app.useLogger()`) and Fastify
   * (`fastify.log`). Express and Next.js own no such thing, so they stay silent unless you pass one —
   * `createConsoleLogger()` is the one-liner.
   */
  logger?: Logger | false;
  /**
   * Cross-origin access for browser clients (Agent Chat UI, React `useStream`). When omitted, CORS is
   * driven by the config's `http.cors` block (LangGraph-compatible) and is otherwise **off** — we do
   * not default to LangGraph's permissive `origin: "*"`. `true` reflects the request origin (dev),
   * `CorsOptions` restricts origins for production, `false` forces it off. An explicit value wins.
   */
  cors?: boolean | CorsOptions;
  /**
   * Eager-load every declared graph at boot instead of lazily on first request, so graph import
   * errors surface at startup. Load failures are logged, not thrown, so one bad graph never takes the
   * server down.
   */
  warm?: boolean;
  /**
   * Background run-worker tuning. `maxConcurrency` is how many **queued** runs this instance executes
   * at once (default `DEFAULT_RUN_CONCURRENCY`, matching the LangGraph CLI); omit it and skein reads
   * `SKEIN_RUN_CONCURRENCY`, else the LangGraph-compatible `N_JOBS_PER_WORKER`. An explicit value
   * wins, but the environment is still validated so the two sources can't silently disagree.
   *
   * Raising it never weakens per-thread ordering — two runs on one thread are still serialized by the
   * engine's execution lock — but see the head-of-line note in docs/runs-and-redis.md if your workload
   * leans on `multitask_strategy: "enqueue"`. Ignored by the invoke-only surface, which starts no
   * worker.
   *
   * `shutdownGraceMs` is how long `worker.stop()` lets in-flight runs finish before aborting them
   * (default `DEFAULT_SHUTDOWN_GRACE_MS`); omit it and skein reads `SKEIN_SHUTDOWN_GRACE_MS`, with
   * the same explicit-wins-but-still-validated rule. Whatever forces the process to exit must wait
   * longer than this, or the abort step never runs — see docs/deploy.md.
   */
  worker?: RunWorkerOptions;
}

/** Either point at a `langgraph.json` (in-memory runtime) or inject a ready `ProtocolDeps`. */
export type SkeinRuntimeOptions = SkeinRuntimeCommonOptions &
  (
    | {
        config: string;
        /**
         * How graph modules are imported for the in-memory runtime. Defaults to a native dynamic
         * `import()`; `skein dev` injects a vite-backed importer for TypeScript graphs.
         */
        importModule?: ModuleImporter;
        deps?: never;
      }
    | { deps: ProtocolDeps; config?: never; importModule?: never }
  );

export interface ResolvedProtocolRuntime {
  /** The wired runtime — assistants seeded and the background worker already started. */
  runtime: ProtocolRuntime;
  /** CORS mapped from the config's `http.cors`, or `undefined` for the injected-`deps` path. */
  cors?: CorsOptions;
  /**
   * The route table to mount: the full protocol, minus any group the config's `http.disable_*` flags
   * switched off. Always present — the injected-`deps` path has no config to read flags from, so it
   * gets the complete table.
   */
  routes: readonly RouteBinding[];
  /**
   * The logger the engine ended up with, after {@link SkeinRuntimeCommonOptions.logger}'s precedence
   * chain. `undefined` means nothing logs. Adapters read this (rather than `options.logger`) for
   * their own transport-fault logging, so the engine and the transport can never disagree about
   * where output goes.
   */
  logger?: Logger;
}

/** Just the dependencies behind a `{ config } | { deps }` bag — no runtime, no worker. */
export interface ResolvedRuntimeDeps {
  deps: ProtocolDeps;
  /** CORS mapped from the config's `http.cors`, or `undefined` for the injected-`deps` path. */
  cors?: CorsOptions;
  /** The route table to mount — see {@link ResolvedProtocolRuntime.routes}. */
  routes: readonly RouteBinding[];
  /** The resolved logger — see {@link ResolvedProtocolRuntime.logger}. */
  logger?: Logger;
}

/**
 * Apply {@link SkeinRuntimeCommonOptions.logger}'s precedence chain. A `deps.logger` you injected
 * always wins — it is the more specific statement, and it is the one field we must not overwrite
 * (see {@link resolveRuntimeDeps} on why this fills in place rather than copying). Otherwise the
 * explicit option, then the adapter's framework default. `false` means the adapter stays out of it
 * entirely: no default installed, an injected `deps.logger` still standing.
 */
function resolveLogger(
  option: Logger | false | undefined,
  injected: Logger | undefined,
  frameworkLogger: Logger | undefined,
): Logger | undefined {
  if (injected) return injected;
  if (option === false) return undefined;
  return option ?? frameworkLogger;
}

/**
 * Resolve the `{ config } | { deps }` seam down to a `ProtocolDeps` — injected as-is, or fresh
 * in-memory drivers loaded from a `langgraph.json`. This is the half of
 * {@link resolveProtocolRuntime} that stops short of building the engine, so the simplified invoke
 * surface (which needs only graphs + store) doesn't seed assistants or start a run worker it will
 * never use.
 *
 * `frameworkLogger` is the adapter's own default (Nest's `Logger`, `fastify.log`), used only when the
 * caller supplied neither `options.logger` nor `deps.logger`.
 */
export async function resolveRuntimeDeps(
  options: SkeinRuntimeOptions,
  frameworkLogger?: Logger,
): Promise<ResolvedRuntimeDeps> {
  // Imported only on the `{ config }` branch. An adapter handed ready-made `deps` — which is what
  // `embedPostgresGraphs` and every production embedding does — then never loads the `langgraph.json`
  // loader, the in-memory drivers, or `MemorySaver`.
  const loaded = options.deps
    ? { deps: options.deps, cors: undefined, routes: skeinRoutes }
    : await (
        await import("./in-memory-runtime.js")
      ).loadInMemoryRuntime(options.config, options.importModule);

  const logger = resolveLogger(options.logger, loaded.deps.logger, frameworkLogger);
  // Filled in place, never copied. `createGraphInvokeHandler` re-reads its deps on *every request*
  // precisely so a host that configures after mounting still takes effect — `skein dev` sets
  // `exposeErrorStacks` and `logRunActivity` on the deps object after the router exists. Handing the
  // adapters a snapshot would silently freeze those out, and under NestJS/Fastify (which always
  // resolve a framework logger) a copy would happen on every single mount.
  //
  // Only ever *fills a hole*: `resolveLogger` returns an existing `deps.logger` untouched, so this
  // never overwrites a choice the caller made. That is also why an injected `deps.logger` outranks
  // the adapter option rather than the other way round.
  if (logger && !loaded.deps.logger) loaded.deps.logger = logger;
  return { deps: loaded.deps, cors: loaded.cors, routes: loaded.routes, logger };
}

/**
 * Build a `ProtocolRuntime` from adapter options: resolve `deps` (injected, or fresh in-memory
 * drivers from a `langgraph.json`), seed one assistant per declared graph, optionally warm the
 * graphs, and start the background run worker. Returns the runtime plus any CORS derived from the
 * config so the adapter can apply it. The caller owns shutdown (`runtime.worker.stop()`).
 *
 * `frameworkLogger` is the adapter's own default — see {@link resolveRuntimeDeps}.
 */
export async function resolveProtocolRuntime(
  options: SkeinRuntimeOptions,
  frameworkLogger?: Logger,
): Promise<ResolvedProtocolRuntime> {
  const {
    deps,
    cors: corsFromConfig,
    routes,
    logger,
  } = await resolveRuntimeDeps(options, frameworkLogger);

  // Every environment knob is resolved *before* anything is started, so a typo fails cleanly instead of
  // part-way through assembly. Resolving the heap options after `worker.start()` meant a bad
  // `SKEIN_HEAP_WARN_PERCENT` threw with a live queue consumer already running: `skein start` would then
  // tear down the drivers underneath it, and Next.js — which evicts a rejected runtime so the next
  // request retries — would start another worker on every request.
  const heapPressureOptions = resolveHeapPressureOptions();

  // Fills the hole only when nothing has already chosen: an injected `deps.runTimeoutMs` is a deliberate
  // decision by whoever built the deps and outranks the environment, exactly like `deps.logger`.
  const runTimeoutMs = resolveRunTimeoutMs(deps.runTimeoutMs);
  if (runTimeoutMs !== undefined) deps.runTimeoutMs = runTimeoutMs;

  // Resolve worker settings here rather than in each adapter: this is the ONE place options +
  // environment become the worker's settings, so Express/Fastify/NestJS/Next.js and `skein dev`/`start`
  // can't drift.
  const runtime = createProtocolRuntime(deps, {
    worker: {
      ...options.worker,
      maxConcurrency: resolveRunConcurrency(options.worker?.maxConcurrency),
      shutdownGraceMs: resolveShutdownGraceMs(options.worker?.shutdownGraceMs),
    },
  });
  await runtime.service.assistants.registerGraphAssistants();
  if (options.warm) {
    await Promise.all(
      deps.graphs.ids.map((graphId) =>
        deps.graphs.load(graphId).catch((error: unknown) => {
          logger?.warn(`Failed to warm graph "${graphId}".`, error);
        }),
      ),
    );
  }
  runtime.worker.start();

  // Watch heap usage for the life of the worker. Started here rather than in each adapter for the same
  // reason the worker settings are resolved here: one place, so the four adapters and `skein dev`/`start`
  // cannot drift. Free when no logger is configured — it schedules nothing at all.
  // No per-runtime override of `heapStatistics`/`rss`: `node:v8`'s `getHeapStatistics()` and
  // `process.memoryUsage()` both answer on all three runtimes — measured, Bun reports JavaScriptCore's
  // ~262MB ceiling and Deno reports V8's. An override that fed the monitor a snapshot without a limit
  // would make `heap-pressure.ts`'s `if (limit <= 0) return` bail on every tick, so the OOM early
  // warning docs/deploy.md promises would be silently dead on exactly the two runtimes it was added for.
  const heapMonitor = startHeapPressureMonitor({
    ...(logger ? { logger } : {}),
    ...heapPressureOptions,
    // Read at warn time only. `bufferedFrameCount` is a diagnostic the in-memory bus exposes and the
    // Redis one does not, so it is probed rather than required — on Redis the frames are not in this
    // process's heap anyway, which is itself part of the answer.
    context: () => {
      const bufferedFrames = (deps.bus as { bufferedFrameCount?: number }).bufferedFrameCount;
      return {
        inFlightRuns: runtime.worker.inFlightRunCount,
        ...(typeof bufferedFrames === "number" ? { bufferedFrames } : {}),
      };
    },
  });

  // Stopped wherever the worker is stopped, so no adapter has to remember a second teardown call — and
  // an adapter that forgets cannot leave a timer behind. That coupling matters beyond tidiness: a live
  // interval is a GC root, and this one closes over `runtime` and `deps`, so a host that *abandons* a
  // resolved runtime without stopping it now pins the whole thing (store, threads, buffered frames)
  // rather than letting it be collected. `stop()` is the contract; Next.js's runtime singleton and every
  // adapter's shutdown path already honour it. Delegated field by field rather than spread:
  // `inFlightRunCount` is a getter, and spreading would freeze it at its value right now.
  const worker: RunWorker = {
    get inFlightRunCount() {
      return runtime.worker.inFlightRunCount;
    },
    start: () => runtime.worker.start(),
    stop: async () => {
      heapMonitor.stop();
      await runtime.worker.stop();
    },
  };

  return { runtime: { ...runtime, worker }, cors: corsFromConfig, routes, logger };
}
