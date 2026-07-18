// The recommended entry point: build the service, the HTTP handler table, and the background
// worker from ONE shared context. Sharing matters — the service's `cancel` and the worker both
// touch the same cancellation registry, so cancelling a background run actually aborts it.

import { createAuthorizingHandlers } from "./auth/authorizing-handlers.js";
import { createContext } from "./context.js";
import { createProtocolHandlers, type ProtocolHandlers } from "./create-handlers.js";
import type { ProtocolDeps } from "./deps.js";
import { createRunWorker, type RunWorker, type RunWorkerOptions } from "./runs/run-worker.js";
import { createProtocolServiceFromContext, type ProtocolService } from "./service.js";

export interface ProtocolRuntimeOptions {
  worker?: RunWorkerOptions;
}

export interface ProtocolRuntime {
  service: ProtocolService;
  handlers: ProtocolHandlers;
  worker: RunWorker;
}

/**
 * Wire the whole engine together over a single shared context. Call
 * `runtime.service.assistants.registerGraphAssistants()` once at startup to seed assistants, then
 * `runtime.worker.start()` to process background runs.
 */
export function createProtocolRuntime(
  deps: ProtocolDeps,
  options: ProtocolRuntimeOptions = {},
): ProtocolRuntime {
  const context = createContext(deps);
  const service = createProtocolServiceFromContext(context);
  // When an auth engine is injected, every request is authenticated + authorized through one
  // transport-neutral seam; without it, the handler table is unchanged (unauthenticated, as before).
  const handlers = deps.auth
    ? createAuthorizingHandlers(context, deps.auth)
    : createProtocolHandlers(service);
  return {
    service,
    handlers,
    worker: createRunWorker(context, options.worker),
  };
}
