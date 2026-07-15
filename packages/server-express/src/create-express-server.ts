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

export interface SkeinExpressServer {
  /** The Express app, protocol mounted at `/`. Mount extra middleware or routes before `listen`. */
  app: Express;
  /** The wired runtime (assistants, handlers, worker). */
  runtime: ProtocolRuntime;
  /** Start listening; resolves with the Node `Server` once bound. Defaults to port 2024. */
  listen(port?: number, host?: string): Promise<Server>;
  /** Stop the run worker and close the HTTP server (if listening). */
  close(): Promise<void>;
}

/** Build an Express server hosting the Agent Protocol, ready to `listen`. */
export async function createExpressServer(
  options: SkeinRouterOptions,
): Promise<SkeinExpressServer> {
  const { router, runtime } = await skeinRouter(options);
  const app = express();
  // Log requests before the router handles them, when a logger is provided (e.g. `skein dev`).
  if (options.logger) app.use(requestLogger(options.logger));
  app.use(router);

  let server: Server | undefined;

  return {
    app,
    runtime,
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
