// The lifecycle-owning convenience: a ready Fastify app with the protocol mounted at the root, plus
// `listen`/`close` that also start and stop the background run worker. This is the standalone
// equivalent of `createExpressServer` — a dedicated server whose only job is to serve the graphs.
// To instead mount the protocol inside an existing Fastify app, register `skeinPlugin` under a prefix.

import type { Server } from "node:http";

import type { ProtocolRuntime } from "@skein-js/agent-protocol";
import { resolveProtocolRuntime, type SkeinRuntimeOptions } from "@skein-js/server-kit";
import Fastify, { type FastifyInstance } from "fastify";

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

/** Build a Fastify server hosting the Agent Protocol, ready to `listen`. */
export async function createFastifyServer(
  options: SkeinRuntimeOptions,
): Promise<SkeinFastifyServer> {
  const { runtime, cors } = await resolveProtocolRuntime(options);
  const app = Fastify();

  // Liveness probe for platform health checks (Railway's healthcheckPath, k8s, load balancers).
  // Kept dependency-free on purpose, mirroring the LangGraph platform's `/ok`.
  app.get("/ok", async () => ({ ok: true }));

  await registerSkeinHandlers(app, runtime.handlers, {
    logger: options.logger,
    // Explicit option wins; otherwise fall back to the config's `http.cors`, else off.
    cors: options.cors ?? cors ?? false,
  });

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
