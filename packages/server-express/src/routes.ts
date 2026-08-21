// The pure Express transport shim that mounts the Agent Protocol handler table. The route table
// (`skeinRoutes`) and the `copyThreadIdIntoBody` rule are transport-neutral and live with the engine in
// @skein-js/agent-protocol; this file only maps each Express request onto the injected handler table
// and serializes the result. It adds no protocol logic, so a caller with custom `ProtocolDeps` (e.g.
// Postgres + Redis for `skein up`) can mount it directly.

import {
  copyThreadIdIntoBody,
  skeinRoutes,
  type Logger,
  type ProtocolHandlers,
  type RouteBinding,
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
  /**
   * Body-parser limits for the JSON request bodies the protocol accepts. Defaults to `express.json()`'s
   * own 100kb.
   *
   * Worth raising deliberately rather than by accident: a run's `input` is a graph state, and a thread
   * carrying a long message history or a base64 attachment passes 100kb easily — at which point every
   * request 413s with an error that names the body parser, not skein. Worth *lowering* on a small
   * instance, since the limit is per in-flight request.
   */
  json?: { limit?: string | number };
  /**
   * The route table to mount. Defaults to the whole protocol; `skeinRouter` passes the table the
   * config's `http.disable_*` flags left behind, so a disabled resource is simply never registered and
   * a request for it falls through to the app's own 404 (what `langgraph dev` does).
   */
  routes?: readonly RouteBinding[];
}

/**
 * Reject a `limit` the body parser would silently read as *unlimited*.
 *
 * `bytes.parse` returns `null` for anything it cannot understand (`"10mbb"`, `"10 MB"`), and `raw-body`
 * treats a `null` limit as no limit at all — so a typo in this option would remove the body cap from
 * every route rather than failing. Loud at mount time instead.
 */
export function requireParsableLimit(limit: string | number | undefined): void {
  if (limit === undefined) return;
  if (typeof limit === "number") {
    if (Number.isFinite(limit) && limit > 0) return;
    throw new TypeError(`json.limit must be a positive number of bytes (got ${limit}).`);
  }
  // The same grammar `bytes.parse` accepts: a number with an optional unit suffix.
  if (/^\d+(\.\d+)?\s*(b|kb|mb|gb|tb|pb)?$/i.test(limit.trim())) return;
  throw new TypeError(
    `json.limit must be a byte size like "1mb" or a number of bytes (got "${limit}"). ` +
      `An unparsable value would be read as *no* limit.`,
  );
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
  requireParsableLimit(options.json?.limit);

  // Routes that asked for the body as text get a parser *before* the JSON one, because `express.json`
  // consumes the stream for every request routed into this router — not just the ones it matches. A
  // text parser registered afterwards would find nothing left, which is the trap the hand-written
  // version of this integration documented: mount order is load-bearing and fails silently.
  //
  // `type: "*/*"` because a provider chooses the content type, not us: Twilio sends form-encoded,
  // Slack sends JSON, and a channel needs the same bytes either way. `body-parser` sets `req._body`
  // once it has consumed a stream and every other parser skips a request already marked, so the JSON
  // parser below leaves these alone.
  const textRoutes = new Set(
    (options.routes ?? skeinRoutes)
      .filter((route) => route.retainRawBody)
      .map((route) => route.path),
  );
  if (textRoutes.size > 0) {
    // `type` is applied **after** the caller's options, not before. Spreading `options.json` last let
    // a host that narrowed it (say `type: "application/json"`) silently un-match every other content
    // type, so a form-encoded provider request fell through to the JSON parser and the channel saw an
    // empty body. Size limits and the rest of the caller's options still apply.
    const parseText = express.text({ ...(options.json ?? {}), type: "*/*" });
    router.use((req, res, next) => {
      if (!textRoutes.has(req.path)) return next();
      parseText(req, res, next);
    });
  }

  router.use(express.json(options.json ?? {}));

  for (const binding of options.routes ?? skeinRoutes) {
    const invoke = handlers[binding.handler];
    router[binding.method](binding.path, async (req: Request, res: Response) => {
      // Signals a client that went away, so a run created with `on_disconnect: "cancel"` stops instead
      // of running to completion for a response nobody will read. Registered before the response is
      // written, so it precedes the SSE pipe's own `close` listener and the abort is observed before
      // the frame iterator is torn down.
      const disconnected = new AbortController();
      res.once("close", () => disconnected.abort(new Error("client disconnected")));
      try {
        const request = { ...toProtocolRequest(req), signal: disconnected.signal };
        const response = await invoke(
          binding.foldThreadIdIntoBody ? copyThreadIdIntoBody(request) : request,
        );
        await sendProtocolResponse(response, res);
      } catch (error) {
        sendErrorResponse(error, res, options.logger);
      }
    });
  }

  return router;
}
