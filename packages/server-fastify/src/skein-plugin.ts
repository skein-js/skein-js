// The Fastify transport shim. `registerSkeinHandlers` is the pure piece: it binds the shared route
// table (`skeinRoutes` from @skein-js/agent-protocol) to a `ProtocolHandlers` table on a Fastify
// instance, adding no protocol logic. `skeinPlugin` is the ergonomic wrapper for embedding: it builds
// the runtime from `{ config } | { deps }`, mounts the routes, and manages the background worker's
// lifecycle. Register it under a prefix to serve the protocol alongside your own app's routes.

import {
  foldThreadId,
  skeinRoutes,
  type HttpMethod,
  type Logger,
  type ProtocolHandlers,
} from "@skein-js/agent-protocol";
import {
  resolveProtocolRuntime,
  type CorsOptions,
  type SkeinRuntimeOptions,
} from "@skein-js/server-kit";
import type { FastifyInstance, FastifyPluginAsync, HTTPMethods } from "fastify";

import { sendErrorResponse } from "./error-response.js";
import { sendProtocolResponse } from "./send-protocol-response.js";
import { toProtocolRequest } from "./to-protocol-request.js";

/** Options for `skeinPlugin` — the same `{ config } | { deps }` seam every skein adapter accepts. */
export type SkeinPluginOptions = SkeinRuntimeOptions;

export interface HandlerRoutesOptions {
  /** Structured logger for unexpected (non-`SkeinHttpError`) faults. */
  logger?: Logger;
  /**
   * Cross-origin access, needed by browser clients that run on a different origin than the server.
   * `true` reflects the request origin (permissive dev); pass `CorsOptions` to restrict origins;
   * omit/`false` to disable. Enabling CORS requires the optional peer `@fastify/cors` to be installed.
   */
  cors?: boolean | CorsOptions;
}

const HTTP_METHOD_TO_FASTIFY: Record<HttpMethod, HTTPMethods> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
};

/**
 * Bind the Agent Protocol route table to a handler table on a Fastify instance — the pure shim. It
 * assembles no runtime and knows no storage driver, so a caller with custom `ProtocolDeps` can mount
 * it over any `ProtocolHandlers`. Registers CORS first (when enabled) so preflight `OPTIONS` and the
 * `Access-Control-Allow-*` headers cover every route, including the SSE streams.
 */
export async function registerSkeinHandlers(
  fastify: FastifyInstance,
  handlers: ProtocolHandlers,
  options: HandlerRoutesOptions = {},
): Promise<void> {
  if (options.cors) {
    // `@fastify/cors` is an optional peer — only needed when CORS is on. Load it lazily so the
    // adapter installs cleanly without it, and give a clear error if it is enabled but missing.
    let fastifyCors: FastifyPluginAsync<Record<string, unknown>>;
    try {
      fastifyCors = (await import("@fastify/cors")).default as unknown as FastifyPluginAsync<
        Record<string, unknown>
      >;
    } catch {
      throw new Error(
        "CORS is enabled but @fastify/cors is not installed. Install it (npm i @fastify/cors) " +
          "or disable CORS.",
      );
    }
    await fastify.register(
      fastifyCors,
      (options.cors === true ? { origin: true } : options.cors) as Record<string, unknown>,
    );
  }

  // Tolerate an empty body sent with `Content-Type: application/json`: Fastify's default parser 400s
  // on it, whereas Express (`express.json()`) treats it as `{}`. Replace the JSON parser (in this
  // encapsulation context) with one that maps an empty body to `{}` and still 400s malformed JSON.
  fastify.removeContentTypeParser("application/json");
  fastify.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = (typeof body === "string" ? body : body.toString()).trim();
    if (text === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (error) {
      done(error as Error);
    }
  });

  for (const binding of skeinRoutes) {
    const invoke = handlers[binding.handler];
    fastify.route({
      method: HTTP_METHOD_TO_FASTIFY[binding.method],
      url: binding.path,
      handler: async (req, reply) => {
        try {
          const request = toProtocolRequest(req);
          const response = await invoke(
            binding.foldThreadIdIntoBody ? foldThreadId(request) : request,
          );
          await sendProtocolResponse(response, reply);
        } catch (error) {
          sendErrorResponse(error, reply, options.logger);
        }
        // Returning the (sent or hijacked) reply tells Fastify the response is fully handled.
        return reply;
      },
    });
  }
}

/**
 * A Fastify plugin that serves the Agent Protocol. Builds the runtime from `{ config }` (in-memory
 * dev runtime) or `{ deps }` (bring-your-own drivers), seeds one assistant per graph, starts the
 * background run worker, and stops it on `onClose`. Encapsulated, so registering it under a prefix
 * keeps skein's routes + CORS isolated from the rest of your app:
 *
 * ```ts
 * await app.register(skeinPlugin, { prefix: "/agent", config: "./langgraph.json" });
 * ```
 */
export const skeinPlugin: FastifyPluginAsync<SkeinPluginOptions> = async (fastify, options) => {
  const { runtime, cors } = await resolveProtocolRuntime(options);
  await registerSkeinHandlers(fastify, runtime.handlers, {
    logger: options.logger,
    // Explicit option wins; otherwise fall back to the config's `http.cors`, else off.
    cors: options.cors ?? cors ?? false,
  });
  fastify.addHook("onClose", async () => {
    await runtime.worker.stop();
  });
};
