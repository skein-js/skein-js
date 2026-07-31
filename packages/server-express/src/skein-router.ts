// The convenience assemblers over the pure shim. `skeinRouter` builds a fully-wired protocol runtime
// (via server-kit's shared `resolveProtocolRuntime`) and returns both the mountable `Router` and the
// `runtime` (so the caller can `worker.stop()` on shutdown). Pass `{ config }` for the in-memory
// `skein dev` runtime, or `{ deps }` to bring your own persistent drivers (Postgres + Redis for
// `skein up`) through the same `ProtocolDeps` seam.

import type { Logger, ProtocolRuntime, RouteBinding } from "@skein-js/agent-protocol";
import { resolveProtocolRuntime, type SkeinRuntimeOptions } from "@skein-js/server-kit";
import type { Router } from "express";

import { createHandlerRouter } from "./routes.js";

/** Either point at a `langgraph.json` (in-memory runtime) or inject a ready `ProtocolDeps`. */
export type SkeinRouterOptions = SkeinRuntimeOptions & {
  /** Body-parser limits for JSON request bodies. Defaults to `express.json()`'s 100kb. */
  json?: { limit?: string | number };
  /**
   * Log a line per HTTP request. Defaults to whether a `logger` was passed to the adapter.
   *
   * That default is right for `skein dev` — asking the adapter for a logger is asking to see traffic —
   * and wrong for a production server, which needs a logger so failed runs are reported at all but does
   * not want two lines per request. Set it explicitly to separate the two.
   */
  requestLog?: boolean;
  /**
   * Route table to mount, overriding what the config's `http.disable_*` flags resolved to. Rarely
   * needed — pass it to serve a deliberately narrower surface than the config declares (or, in a test,
   * to exercise a disabled group over the injected-`deps` path, which has no config to read).
   */
  routes?: readonly RouteBinding[];
};

export interface SkeinRouter {
  /** Mount on an Express app: `app.use(router)`. */
  router: Router;
  /** The wired runtime — call `runtime.worker.stop()` on shutdown to drain background runs. */
  runtime: ProtocolRuntime;
  /**
   * The logger the engine ended up with — `options.logger`, else an injected `deps.logger`, else
   * nothing. Express owns no logger of its own, so unlike NestJS and Fastify there is no default
   * here: pass `createConsoleLogger()` to see what skein reports.
   */
  logger?: Logger;
}

/**
 * Wire a protocol runtime and return its mountable router. Seeds one assistant per declared graph
 * and starts the background run worker before returning, so the router is ready to serve.
 */
export async function skeinRouter(options: SkeinRouterOptions): Promise<SkeinRouter> {
  // No framework fallback: Express has no logger of its own to borrow, and a library should not
  // decide on its host's behalf to start writing to stdout.
  const { runtime, cors, routes, logger } = await resolveProtocolRuntime(options);
  const router = createHandlerRouter(runtime.handlers, {
    // Explicit option wins; otherwise the table the config's `http.disable_*` flags left behind.
    routes: options.routes ?? routes,
    // The resolved logger, so transport faults and engine failures land in the same place.
    logger,
    // Explicit option wins; otherwise fall back to the config's `http.cors`, else off.
    cors: options.cors ?? cors ?? false,
    ...(options.json ? { json: options.json } : {}),
  });
  return { router, runtime, logger };
}
