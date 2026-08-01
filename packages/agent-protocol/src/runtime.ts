// The recommended entry point: build the service, the HTTP handler table, the background worker and
// the cron scheduler from ONE shared context. Sharing matters — the service's `cancel` and the
// worker both touch the same cancellation registry, so cancelling a background run actually aborts
// it, and the scheduler creates runs through the same store the worker drains.

import { createAuthorizingHandlers } from "./auth/authorizing-handlers.js";
import { createContext } from "./context.js";
import { createProtocolHandlers, type ProtocolHandlers } from "./create-handlers.js";
import {
  createCronScheduler,
  type CronScheduler,
  type CronSchedulerOptions,
} from "./crons/cron-scheduler.js";
import type { ProtocolDeps } from "./deps.js";
import { createRunWorker, type RunWorker, type RunWorkerOptions } from "./runs/run-worker.js";
import { createProtocolServiceFromContext, type ProtocolService } from "./service.js";

/** Options for {@link createProtocolRuntime}. */
export interface ProtocolRuntimeOptions {
  /** Tuning for the background run worker (max concurrency, shutdown grace period). */
  worker?: RunWorkerOptions;
  /** Tuning for the cron scheduler (tick interval, batch size, or `enabled: false` to switch it off). */
  scheduler?: CronSchedulerOptions;
}

/** The wired engine: the service, the handler table, the background worker, and the cron scheduler. */
export interface ProtocolRuntime {
  /** High-level operations over assistants / threads / runs / crons / store. */
  service: ProtocolService;
  /** The transport-neutral HTTP handler table an adapter dispatches requests into. */
  handlers: ProtocolHandlers;
  /**
   * The background worker that drains the run queue; `start()` it after seeding assistants.
   *
   * Stopping it also stops the cron scheduler and closes the abort-channel subscription — see the
   * teardown note below.
   */
  worker: RunWorker;
  /**
   * The loop that fires due crons.
   *
   * Not optional, so a host never has to branch on whether it exists. It is started and stopped
   * alongside the worker by {@link ProtocolRuntime.worker}, and exposed here for the rare host that
   * wants to drive `tickOnce()` itself — on a platform that will not keep a timer alive, say.
   */
  scheduler: CronScheduler;
}

/**
 * Wire the whole engine together over a single shared context. Call
 * `runtime.service.assistants.registerGraphAssistants()` once at startup to seed assistants, then
 * `runtime.worker.start()` to process background runs and fire schedules.
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
  const scheduler = createCronScheduler(context, options.scheduler);

  // Both the scheduler and the abort-channel subscription hang off the worker's lifecycle rather
  // than off methods of their own. Five adapters plus the CLI already call `worker.start()` and
  // `worker.stop()`, and none of them will learn a second pair — so a host that forgets cannot leave
  // a scheduler firing into a torn-down store, or a Redis subscriber holding the process open.
  //
  // Order matters on the way down: the scheduler stops FIRST, so nothing new is queued while the
  // worker drains. Stopping them the other way round would race new fires against the drain.
  const subscription = deps.abortChannel?.subscribe(({ run_id, reason }) => {
    context.control.applyRemoteAbort(run_id, reason);
  });
  // Cross-instance cancellation, wired in one place because both halves must agree: outbound (an
  // abort for a run executing elsewhere is republished) and inbound (a peer's request is applied to
  // the local registry). Subscribed above, at assembly, so a request cannot arrive before there is
  // anywhere to put it. `applyRemoteAbort`, not `abort` — the latter would forward it straight back out.
  if (deps.abortChannel) context.control.useAbortChannel(deps.abortChannel, deps.logger);

  return {
    service,
    handlers,
    scheduler,
    worker: {
      get inFlightRunCount() {
        return worker.inFlightRunCount;
      },
      start: () => {
        worker.start();
        scheduler.start();
      },
      stop: async () => {
        await scheduler.stop();
        await worker.stop();
        await subscription?.close();
      },
    },
  };
}
