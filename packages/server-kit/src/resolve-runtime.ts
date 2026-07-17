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
} from "@skein-js/agent-protocol";
import type { ModuleImporter } from "@skein-js/config";
import type { CorsOptions } from "cors";

import { loadInMemoryRuntime } from "./in-memory-runtime.js";

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

/**
 * Build a `ProtocolRuntime` from adapter options: resolve `deps` (injected, or fresh in-memory
 * drivers from a `langgraph.json`), seed one assistant per declared graph, optionally warm the
 * graphs, and start the background run worker. Returns the runtime plus any CORS derived from the
 * config so the adapter can apply it. The caller owns shutdown (`runtime.worker.stop()`).
 */
export async function resolveProtocolRuntime(
  options: SkeinRuntimeOptions,
): Promise<ResolvedProtocolRuntime> {
  let deps: ProtocolDeps;
  let corsFromConfig: CorsOptions | undefined;
  if (options.deps) {
    deps = options.deps;
  } else {
    const loaded = await loadInMemoryRuntime(options.config, options.importModule);
    deps = loaded.deps;
    corsFromConfig = loaded.cors;
  }

  const runtime = createProtocolRuntime(deps);
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
