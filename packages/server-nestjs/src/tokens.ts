// DI tokens for the skein NestJS module. Symbols (not strings) so they can't collide with a host
// app's own providers.

/** Provides the resolved `ProtocolRuntime` (handlers + worker) to the middleware and lifecycle. */
export const SKEIN_RUNTIME = Symbol("skein:runtime");
/** Provides the optional structured logger (or `null`) for unexpected-fault logging. */
export const SKEIN_LOGGER = Symbol("skein:logger");
/** Provides the explicit `cors` option (or `null`) so the middleware can apply CORS to skein routes. */
export const SKEIN_CORS = Symbol("skein:cors");
/** Provides the resolved single-graph invoke surface (handler + matcher) to `SkeinInvokeMiddleware`. */
export const SKEIN_INVOKE = Symbol("skein:invoke");
