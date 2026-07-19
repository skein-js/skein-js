// @skein-js/fastify — Fastify adapter for skein-js. A thin transport shim: it maps Fastify requests
// onto @skein-js/agent-protocol's transport-neutral handler table and serializes JSON / 204 / SSE
// responses back out. It adds no protocol logic of its own. See docs/agent-protocol.md.

// Convenience assemblers — the common entry points.
export { createFastifyServer } from "./create-fastify-server.js";
export type { SkeinFastifyServer } from "./create-fastify-server.js";
export { skeinPlugin, registerSkeinHandlers } from "./skein-plugin.js";
export type { SkeinPluginOptions, HandlerRoutesOptions } from "./skein-plugin.js";

// The simplified serving surface: every graph as a plain `POST /invoke/:graph_id` endpoint, for
// non-chat workloads. See docs/serving-a-single-graph.md.
export { skeinInvokePlugin } from "./skein-invoke-plugin.js";
export type { SkeinInvokePluginOptions } from "./skein-invoke-plugin.js";

// Low-level request/response mappers, for adapters composing their own routing.
export { toProtocolRequest } from "./to-protocol-request.js";
export { sendProtocolResponse } from "./send-protocol-response.js";
export { sendErrorResponse } from "./error-response.js";

// The route table + runtime resolution live in the shared packages; re-export the route table so
// Fastify callers can reach it without importing @skein-js/agent-protocol directly.
export { skeinRoutes } from "@skein-js/agent-protocol";
export type { SkeinRuntimeOptions } from "@skein-js/server-kit";
