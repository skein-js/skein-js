// The convenience assemblers over the pure shim. `skeinRouter` builds a fully-wired protocol runtime
// (via server-kit's shared `resolveProtocolRuntime`) and returns both the mountable `Router` and the
// `runtime` (so the caller can `worker.stop()` on shutdown). Pass `{ config }` for the in-memory
// `skein dev` runtime, or `{ deps }` to bring your own persistent drivers (Postgres + Redis for
// `skein up`) through the same `ProtocolDeps` seam.

import type { ProtocolRuntime } from "@skein-js/agent-protocol";
import { resolveProtocolRuntime, type SkeinRuntimeOptions } from "@skein-js/server-kit";
import type { Router } from "express";

import { createHandlerRouter } from "./routes.js";

/** Either point at a `langgraph.json` (in-memory runtime) or inject a ready `ProtocolDeps`. */
export type SkeinRouterOptions = SkeinRuntimeOptions;

export interface SkeinRouter {
  /** Mount on an Express app: `app.use(router)`. */
  router: Router;
  /** The wired runtime — call `runtime.worker.stop()` on shutdown to drain background runs. */
  runtime: ProtocolRuntime;
}

/**
 * Wire a protocol runtime and return its mountable router. Seeds one assistant per declared graph
 * and starts the background run worker before returning, so the router is ready to serve.
 */
export async function skeinRouter(options: SkeinRouterOptions): Promise<SkeinRouter> {
  const { runtime, cors } = await resolveProtocolRuntime(options);
  const router = createHandlerRouter(runtime.handlers, {
    logger: options.logger,
    // Explicit option wins; otherwise fall back to the config's `http.cors`, else off.
    cors: options.cors ?? cors ?? false,
  });
  return { router, runtime };
}
