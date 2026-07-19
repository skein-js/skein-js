// The simplified serving surface on Fastify: mount every declared graph as a plain endpoint
// (`POST /invoke/:graph_id`) that runs it to completion and returns its final state. Separate from
// `skeinPlugin` on purpose — this is the whole surface for a non-chat service (no threads,
// assistants, or runs), and registering both is just two `register` calls. See
// docs/serving-a-single-graph.md.

import {
  createGraphInvokeHandler,
  graphInvokeRoutes,
  type GraphInvokeOptions,
} from "@skein-js/agent-protocol";
import { resolveRuntimeDeps, type SkeinRuntimeOptions } from "@skein-js/server-kit";
import type { FastifyPluginAsync } from "fastify";

import { sendErrorResponse } from "./error-response.js";
import { sendProtocolResponse } from "./send-protocol-response.js";
import { HTTP_METHOD_TO_FASTIFY, prepareSkeinContext } from "./skein-plugin.js";
import { toProtocolRequest } from "./to-protocol-request.js";

export type SkeinInvokePluginOptions = SkeinRuntimeOptions &
  GraphInvokeOptions & {
    /**
     * Path prefix *inside* this plugin, appended to any Fastify `prefix` it is registered under.
     * Defaults to `/invoke`; pass `"/"` to serve `:graph_id` directly at the registration prefix.
     */
    invokePrefix?: string;
  };

/**
 * A Fastify plugin serving `POST <invokePrefix>/:graph_id`. Resolves deps from the shared
 * `{ config } | { deps }` seam; seeds no assistants and starts no background run worker, since an
 * invoke-only service needs neither.
 *
 * ```ts
 * await app.register(skeinInvokePlugin, { prefix: "/api", deps });
 * // → POST /api/invoke/:graph_id
 * ```
 */
export const skeinInvokePlugin: FastifyPluginAsync<SkeinInvokePluginOptions> = async (
  fastify,
  options,
) => {
  const { deps, cors } = await resolveRuntimeDeps(options);
  const invoke = createGraphInvokeHandler(deps, { streamMode: options.streamMode });

  await prepareSkeinContext(fastify, {
    logger: options.logger,
    // Explicit option wins; otherwise fall back to the config's `http.cors`, else off.
    cors: options.cors ?? cors ?? false,
  });

  for (const binding of graphInvokeRoutes(options.invokePrefix)) {
    fastify.route({
      method: HTTP_METHOD_TO_FASTIFY[binding.method],
      url: binding.path,
      handler: async (req, reply) => {
        // Abort the graph when the client goes away, so a disconnect doesn't leave it running to
        // completion (burning model tokens) for a response nobody will read.
        const disconnected = new AbortController();
        reply.raw.once("close", () => disconnected.abort(new Error("client disconnected")));
        try {
          const request = { ...toProtocolRequest(req), signal: disconnected.signal };
          await sendProtocolResponse(await invoke(request), reply);
        } catch (error) {
          sendErrorResponse(error, reply, options.logger);
        }
        // Returning the (sent or hijacked) reply tells Fastify the response is fully handled.
        return reply;
      },
    });
  }
};
