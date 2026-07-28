// The lifecycle-owning convenience: a ready `express()` app with the protocol mounted at the root,
// plus `listen`/`close` that also start and stop the background run worker. This is what `skein dev`
// (and `skein up`, with injected deps) boots in-process.

import type { Server } from "node:http";

import type { Logger, ProtocolRuntime } from "@skein-js/agent-protocol";
import express, { type Express, type RequestHandler } from "express";

import { skeinRouter, type SkeinRouterOptions } from "./skein-router.js";

/**
 * Two log lines per request, mirroring `langgraph dev`: `<-- GET /threads/x` when the request comes
 * in, then `--> GET /threads/x 200 5ms` when it completes. The completion line fires on `finish`
 * (response fully sent) or `close` (client aborted first — common when an SSE stream is cancelled),
 * whichever comes first, so cancelled streams are not silently omitted. A `once` guard keeps the
 * completion to a single line per request.
 */
function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const startedAt = Date.now();
    logger.info(`<-- ${req.method} ${req.originalUrl}`);
    let logged = false;
    const log = () => {
      if (logged) return;
      logged = true;
      logger.info(
        `--> ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms`,
      );
    };
    res.once("finish", log);
    res.once("close", log);
    next();
  };
}

/** The result of {@link createExpressServer}: the Express app, the wired runtime, and lifecycle helpers. */
export interface SkeinExpressServer {
  /** The Express app, protocol mounted at `/`. Mount extra middleware or routes before `listen`. */
  app: Express;
  /** The wired runtime (assistants, handlers, worker). */
  runtime: ProtocolRuntime;
  /**
   * The logger skein resolved to, so a host's own error paths can log where skein does. Express
   * installs no default — see `SkeinRouter.logger`.
   */
  logger?: Logger;
  /** Start listening; resolves with the Node `Server` once bound. Defaults to port 2024. */
  listen(port?: number, host?: string): Promise<Server>;
  /** Stop the run worker and close the HTTP server (if listening). */
  close(): Promise<void>;
}

/** Build an Express server hosting the Agent Protocol, ready to `listen`. */
export async function createExpressServer(
  options: SkeinRouterOptions,
): Promise<SkeinExpressServer> {
  const { router, runtime, logger } = await skeinRouter(options);
  const app = express();
  // Request lines are keyed on the *explicit* option, not the resolved logger: asking the adapter for
  // a logger is asking for request logging (`skein dev` does), whereas injecting `deps.logger` is
  // asking for skein's own reports — a per-request line for every poll is not what that user wanted.
  //
  // `requestLog` overrides that inference in both directions, which is what a production server needs:
  // it must pass a logger so a failed run is reported at all, but two lines per request is noise that
  // buries the reports it was passed for.
  // Inference keys on the *explicit* option; the mounted logger is the *resolved* one. An injected
  // `deps.logger` therefore stays quiet by default (right — that user asked for skein's reports, not a
  // line per poll) but is used when `requestLog: true` asks for traffic, which is what "overrides in
  // both directions" has to mean.
  const requestLog = options.requestLog ?? Boolean(options.logger);
  if (requestLog && logger) app.use(requestLogger(logger));
  // Liveness probe for platform health checks (Railway's healthcheckPath, k8s, load balancers).
  // Kept dependency-free on purpose: a readiness check that touches Postgres/Redis would let a
  // transient DB blip flap a healthy instance. Path mirrors the LangGraph platform's `/ok`.
  app.get("/ok", (_req, res) => {
    res.json({ ok: true });
  });
  app.use(router);

  let server: Server | undefined;

  return {
    app,
    runtime,
    logger,
    listen: (port = 2024, host = "localhost") =>
      new Promise<Server>((resolve, reject) => {
        const bound = app.listen(port, host, () => resolve(bound));
        // A bind failure (EADDRINUSE / EACCES) surfaces as an `error` event, not a throw — reject
        // rather than letting it become an uncaught exception that leaves this promise unsettled.
        bound.once("error", reject);
        server = bound;
      }),
    close: async () => {
      await runtime.worker.stop();
      const bound = server;
      server = undefined; // idempotent: a second close() is a no-op, not ERR_SERVER_NOT_RUNNING
      if (bound) {
        await new Promise<void>((resolve, reject) => {
          bound.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  };
}
