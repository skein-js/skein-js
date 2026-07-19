// @skein-js/nestjs — NestJS adapter for skein-js. A thin transport shim: `SkeinModule` mounts
// @skein-js/agent-protocol's transport-neutral handler table as middleware and serializes JSON / 204
// / SSE responses back out. It adds no protocol logic of its own. Targets NestJS's default Express
// platform. See docs/agent-protocol.md.

// The dynamic module — the primary entry point (embed alongside your own controllers).
export { SkeinModule } from "./skein.module.js";
// The middleware, for callers wiring their own module.
export { SkeinMiddleware } from "./skein.middleware.js";
// DI tokens (the resolved runtime is exported from the module for advanced use).
export { SKEIN_RUNTIME, SKEIN_LOGGER, SKEIN_CORS, SKEIN_INVOKE } from "./tokens.js";

// The simplified serving surface: every graph as a plain `POST /invoke/:graph_id` endpoint, for
// non-chat workloads. See docs/serving-a-single-graph.md.
export { SkeinInvokeModule } from "./skein-invoke.module.js";
export type { SkeinInvokeModuleOptions } from "./skein-invoke.module.js";
export { SkeinInvokeMiddleware } from "./skein-invoke.middleware.js";
export type { ResolvedInvokeSurface } from "./skein-invoke.middleware.js";

// Standalone convenience server.
export { createNestServer } from "./create-nest-server.js";
export type { SkeinNestServer } from "./create-nest-server.js";

// Low-level mappers, for callers composing their own routing. The Node response serializers are
// shared and re-exported from @skein-js/server-kit for convenience.
export { toProtocolRequest } from "./to-protocol-request.js";
export { sendNodeResponse, sendNodeError } from "@skein-js/server-kit";

// Runtime-resolution option shape (shared across skein adapters).
export type { SkeinRuntimeOptions } from "@skein-js/server-kit";
