// The runtime-resolution step every framework adapter shares: turn a `{ config } | { deps }` option
// bag into a live `ProtocolRuntime` with assistants seeded and the background worker running. Kept
// here (not in a single adapter) so Express/Fastify/NestJS/Next.js resolve the runtime identically
// and can't drift (e.g. one forgetting `registerGraphAssistants()`). The adapter then maps the route
// table onto its own router and manages `runtime.worker.stop()` on shutdown.

import {
  createProtocolRuntime,
  type Logger,
  type ProtocolDeps,
  type ProtocolRuntime,
  type RunWorkerOptions,
} from "@skein-js/agent-protocol";
import type { ModuleImporter } from "@skein-js/config";
import type { CorsOptions } from "cors";

import { loadInMemoryRuntime } from "./in-memory-runtime.js";
import { resolveRunConcurrency } from "./run-concurrency.js";
import { resolveShutdownGraceMs } from "./shutdown-grace.js";

export interface SkeinRuntimeCommonOptions {
  logger?: Logger;
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
}

/** Just the dependencies behind a `{ config } | { deps }` bag — no runtime, no worker. */
export interface ResolvedRuntimeDeps {
  deps: ProtocolDeps;
  /** CORS mapped from the config's `http.cors`, or `undefined` for the injected-`deps` path. */
  cors?: CorsOptions;
}

/**
 * Resolve the `{ config } | { deps }` seam down to a `ProtocolDeps` — injected as-is, or fresh
 * in-memory drivers loaded from a `langgraph.json`. This is the half of
 * {@link resolveProtocolRuntime} that stops short of building the engine, so the simplified invoke
 * surface (which needs only graphs + store) doesn't seed assistants or start a run worker it will
 * never use.
 */
export async function resolveRuntimeDeps(
  options: SkeinRuntimeOptions,
): Promise<ResolvedRuntimeDeps> {
  if (options.deps) return { deps: options.deps };
  const loaded = await loadInMemoryRuntime(options.config, options.importModule);
  return { deps: loaded.deps, cors: loaded.cors };
}

/**
 * Build a `ProtocolRuntime` from adapter options: resolve `deps` (injected, or fresh in-memory
 * drivers from a `langgraph.json`), seed one assistant per declared graph, optionally warm the
 * graphs, and start the background run worker. Returns the runtime plus any CORS derived from the
 * config so the adapter can apply it. The caller owns shutdown (`runtime.worker.stop()`).
 */
export async function resolveProtocolRuntime(
  options: SkeinRuntimeOptions,
): Promise<ResolvedProtocolRuntime> {
  const { deps, cors: corsFromConfig } = await resolveRuntimeDeps(options);

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
          options.logger?.warn(`Failed to warm graph "${graphId}".`, error);
        }),
      ),
    );
  }
  runtime.worker.start();

  return { runtime, cors: corsFromConfig };
}
