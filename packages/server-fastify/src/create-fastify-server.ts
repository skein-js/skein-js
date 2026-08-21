// The lifecycle-owning convenience: a ready Fastify app with the protocol mounted at the root, plus
// `listen`/`close` that also start and stop the background run worker. This is the standalone
// equivalent of `createExpressServer` — a dedicated server whose only job is to serve the graphs.
// To instead mount the protocol inside an existing Fastify app, register `skeinPlugin` under a prefix.

import type { Server } from "node:http";

import type { Logger, ProtocolRuntime, RouteBinding } from "@skein-js/agent-protocol";
import {
  resolveProtocolRuntime,
  type CorsOptions,
  type SkeinRuntimeOptions,
} from "@skein-js/server-kit";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import { createFastifyLogger } from "./fastify-logger.js";
import { registerSkeinHandlers } from "./skein-plugin.js";

export interface SkeinFastifyServer {
  /** The Fastify app, protocol mounted at `/`. Add extra routes/plugins before `listen`. */
  app: FastifyInstance;
  /** The wired runtime (assistants, handlers, worker). */
  runtime: ProtocolRuntime;
  /** Start listening; resolves with the Node `Server` once bound. Defaults to port 2024. */
  listen(port?: number, host?: string): Promise<Server>;
  /** Stop the run worker and close the HTTP server (if listening). */
  close(): Promise<void>;
}

export type SkeinFastifyServerOptions = SkeinRuntimeOptions & {
  /**
   * Options for the underlying `Fastify()` instance. Most usefully `{ logger: true }`, which turns on
   * pino — skein's own logging defaults to that instance, so enabling it here is all it takes to see
   * failed runs. Left off by default, as Fastify itself leaves it off.
   *
   * For plain, uncolored output instead of pino's JSON, pass skein's `logger: createConsoleLogger()`.
   */
  fastify?: FastifyServerOptions;
};

/** Build a Fastify server hosting the Agent Protocol, ready to `listen`. */
export async function createFastifyServer(
  options: SkeinFastifyServerOptions,
): Promise<SkeinFastifyServer> {
  // Built before the runtime is resolved so `app.log` can be skein's default logger — see
  // fastify-logger.ts. With Fastify's own default (`logger` unset) that instance is a no-op, so this
  // server stays as quiet as it always has unless the caller asks for output.
  const app = Fastify(options.fastify);

  // The instance now exists before anything that can fail, so every failure path has to close it —
  // otherwise a bad graph import leaks the app and, with `fastify: { logger: … }`, its log
  // destination (an open file handle or socket) along with it.
  let runtime: ProtocolRuntime;
  let cors: CorsOptions | undefined;
  let logger: Logger | undefined;
  let routes: readonly RouteBinding[] | undefined;
  try {
    ({ runtime, cors, routes, logger } = await resolveProtocolRuntime(
      options,
      createFastifyLogger(app.log),
    ));

    // Liveness probe for platform health checks (Railway's healthcheckPath, k8s, load balancers).
    // Kept dependency-free on purpose, mirroring the LangGraph platform's `/ok`.
    app.get("/ok", async () => ({ ok: true }));

    await registerSkeinHandlers(app, runtime.handlers, {
      // The **resolved** table, not the static one. Dropping it here meant this server silently
      // ignored the route table the runtime resolved — so `http.disable_*` did nothing, and a
      // configured channel's routes were never mounted. `skeinPlugin` next door always passed it,
      // which is why only the standalone server was affected.
      routes,
      logger,
      // Explicit option wins; otherwise fall back to the config's `http.cors`, else off.
      cors: options.cors ?? cors ?? false,
    });
  } catch (error) {
    await app.close();
    throw error;
  }

  let listening = false;

  return {
    app,
    runtime,
    listen: async (port = 2024, host = "localhost") => {
      await app.listen({ port, host });
      listening = true;
      return app.server;
    },
    close: async () => {
      await runtime.worker.stop();
      if (listening) {
        listening = false; // idempotent: a second close() is a no-op
        await app.close();
      }
    },
  };
}
