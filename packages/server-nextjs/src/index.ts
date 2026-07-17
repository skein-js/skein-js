// @skein-js/nextjs — Next.js adapter for skein-js. A thin transport shim: it maps Next.js API
// requests onto @skein-js/agent-protocol's transport-neutral handler table and serializes JSON / 204
// / SSE responses back out. Supports both the App Router (Web `Request`/`Response`) and the Pages
// Router (Node request/response). It adds no protocol logic of its own. See docs/agent-protocol.md.

// App Router (recommended): per-method Route Handlers for `app/<base>/[...path]/route.ts`.
export { createSkeinRouteHandlers } from "./create-route-handlers.js";
export type {
  SkeinRouteHandlers,
  SkeinRouteHandler,
  SkeinRouteHandlerOptions,
} from "./create-route-handlers.js";

// Pages Router: an API route handler for `pages/api/[...path].ts`.
export { createSkeinPagesHandler } from "./create-pages-handler.js";
export type {
  SkeinPagesHandler,
  SkeinPagesHandlerOptions,
  SkeinPagesRequest,
} from "./create-pages-handler.js";

// The memoized runtime accessor (shared across both routers and module reloads).
export { getSkeinRuntime } from "./runtime-singleton.js";

// Low-level serializers, for callers composing their own Next.js routing. The Web serializers are
// Next-specific; the Node ones are shared and re-exported from @skein-js/server-kit for convenience.
export { toWebResponse, webErrorResponse } from "./send-web-response.js";
export { sendNodeResponse, sendNodeError } from "@skein-js/server-kit";

// Runtime-resolution option shape (shared across skein adapters).
export type { SkeinRuntimeOptions } from "@skein-js/server-kit";
