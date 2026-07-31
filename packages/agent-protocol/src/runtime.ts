// The recommended entry point: build the service, the HTTP handler table, and the background
// worker from ONE shared context. Sharing matters — the service's `cancel` and the worker both
// touch the same cancellation registry, so cancelling a background run actually aborts it.

import { createAuthorizingHandlers } from "./auth/authorizing-handlers.js";
import { createContext } from "./context.js";
import { createProtocolHandlers, type ProtocolHandlers } from "./create-handlers.js";
import type { ProtocolDeps } from "./deps.js";
import { createRunWorker, type RunWorker, type RunWorkerOptions } from "./runs/run-worker.js";
import { createProtocolServiceFromContext, type ProtocolService } from "./service.js";

/** Options for {@link createProtocolRuntime}. */
export interface ProtocolRuntimeOptions {
  /** Tuning for the background run worker (max concurrency, shutdown grace period). */
  worker?: RunWorkerOptions;
}

/** The wired engine: the service, the transport-neutral handler table, and the background worker. */
export interface ProtocolRuntime {
  /** High-level operations over assistants / threads / runs / store (used to seed assistants). */
  service: ProtocolService;
  /** The transport-neutral HTTP handler table an adapter dispatches requests into. */
  handlers: ProtocolHandlers;
  /** The background worker that drains the run queue; `start()` it after seeding assistants. */
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
  const worker = createRunWorker(context, options.worker);
  if (!deps.abortChannel) return { service, handlers, worker };

  // Cross-instance cancellation, wired in one place because both halves must agree: outbound (an abort
  // for a run executing elsewhere is republished) and inbound (a peer's request is applied to the local
  // registry). Subscribed here, at assembly, so a request cannot arrive before there is anywhere to put
  // it. `applyRemoteAbort`, not `abort` — the latter would forward it straight back out.
  context.control.useAbortChannel(deps.abortChannel, deps.logger);
  const subscription = deps.abortChannel.subscribe(({ run_id, reason }) => {
    context.control.applyRemoteAbort(run_id, reason);
  });
  return {
    service,
    handlers,
    // Closed with the worker, so a host that already calls `worker.stop()` on shutdown needs no second
    // teardown call — and one that forgets cannot leave a Redis subscriber holding the process open.
    // The worker drains first: an in-flight run may still be signalled while it is winding down.
    worker: {
      get inFlightRunCount() {
        return worker.inFlightRunCount;
      },
      start: () => worker.start(),
      stop: async () => {
        await worker.stop();
        await subscription.close();
      },
    },
  };
}
