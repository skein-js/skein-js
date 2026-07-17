// The pure Express transport shim that mounts the Agent Protocol handler table. The route table
// (`skeinRoutes`) and the `foldThreadId` rule are transport-neutral and live with the engine in
// @skein-js/agent-protocol; this file only maps each Express request onto the injected handler table
// and serializes the result. It adds no protocol logic, so a caller with custom `ProtocolDeps` (e.g.
// Postgres + Redis for `skein up`) can mount it directly.

import {
  foldThreadId,
  skeinRoutes,
  type Logger,
  type ProtocolHandlers,
} from "@skein-js/agent-protocol";
import cors, { type CorsOptions } from "cors";
import express from "express";
import type { Request, Response, Router } from "express";

import { sendErrorResponse } from "./error-response.js";
import { sendProtocolResponse } from "./send-protocol-response.js";
import { toProtocolRequest } from "./to-protocol-request.js";

// Re-export the route table so existing importers of `@skein-js/express`'s `skeinRoutes` keep working
// (the canonical home is now @skein-js/agent-protocol).
export { skeinRoutes } from "@skein-js/agent-protocol";

export interface HandlerRouterOptions {
  /** Structured logger for unexpected (non-`SkeinHttpError`) faults. */
  logger?: Logger;
  /**
   * Cross-origin access, needed by browser clients (Agent Chat UI, React `useStream`) that run on a
   * different origin than the server. `true` reflects the request origin (permissive — good for
   * `skein dev`); pass `CorsOptions` to restrict origins for `skein up`; omit/`false` to disable.
   */
  cors?: boolean | CorsOptions;
}

/**
 * Build an Express `Router` that binds the route table to a handler table. This is the pure shim —
 * it assembles no runtime and knows no storage driver, so callers can mount it over any
 * `ProtocolHandlers` (in-memory for `skein dev`, Postgres + Redis for `skein up`).
 */
export function createHandlerRouter(
  handlers: ProtocolHandlers,
  options: HandlerRouterOptions = {},
): Router {
  const router = express.Router();
  // CORS first, so preflight `OPTIONS` and the `Access-Control-Allow-*` headers apply to every route
  // (including the SSE streams the browser SDKs read cross-origin). `true` reflects the request
  // origin (rather than a bare `*`), which also works for credentialed requests.
  if (options.cors) router.use(cors(options.cors === true ? { origin: true } : options.cors));
  router.use(express.json());

  for (const binding of skeinRoutes) {
    const invoke = handlers[binding.handler];
    router[binding.method](binding.path, async (req: Request, res: Response) => {
      try {
        const request = toProtocolRequest(req);
        const response = await invoke(
          binding.foldThreadIdIntoBody ? foldThreadId(request) : request,
        );
        await sendProtocolResponse(response, res);
      } catch (error) {
        sendErrorResponse(error, res, options.logger);
      }
    });
  }

  return router;
}
