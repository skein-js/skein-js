// @skein-js/express — Express adapter for skein-js. A thin transport shim: it maps Express requests
// onto @skein-js/agent-protocol's transport-neutral handler table and serializes JSON / 204 / SSE
// responses back out. It adds no protocol logic of its own. See docs/agent-protocol.md.

// Convenience assemblers — the common entry points.
export { skeinRouter } from "./skein-router.js";
export type { SkeinRouter, SkeinRouterOptions } from "./skein-router.js";
export { createExpressServer } from "./create-express-server.js";
export type { SkeinExpressServer } from "./create-express-server.js";

// The pure transport shim + route table, for callers wiring their own `ProtocolDeps`. `skeinRoutes`
// is re-exported from its canonical home (@skein-js/agent-protocol) so existing imports keep working.
export { createHandlerRouter, skeinRoutes } from "./routes.js";
export type { HandlerRouterOptions } from "./routes.js";

// Low-level request/response mappers, for adapters composing their own routing.
export { toProtocolRequest } from "./to-protocol-request.js";
export { sendProtocolResponse } from "./send-protocol-response.js";
export { sendErrorResponse } from "./error-response.js";

// Framework-agnostic building blocks now live in @skein-js/server-kit. Re-exported here for
// back-compat, since downstream code (and the adapter guide) has imported them from @skein-js/express.
export {
  loadInMemoryRuntime,
  loadReloadableInMemoryRuntime,
  readLanggraphDevState,
  loadSnapshotIntoStore,
  describeSnapshot,
  corsFromHttpConfig,
  toCorsOptions,
} from "@skein-js/server-kit";
export type {
  InMemoryRuntimeConfig,
  ReloadableInMemoryRuntime,
  DevStateSnapshot,
  DevStateCounts,
  LanggraphCorsConfig,
} from "@skein-js/server-kit";
