// The recommended entry point: build the service, the HTTP handler table, the background worker and
// the cron scheduler from ONE shared context. Sharing matters — the service's `cancel` and the
// worker both touch the same cancellation registry, so cancelling a background run actually aborts
// it, and the scheduler creates runs through the same store the worker drains.

import { resolveAuthContext } from "./auth/authenticate-request.js";
import { createAuthorizingHandlers } from "./auth/authorizing-handlers.js";
import { createContext } from "./context.js";
import { createProtocolHandlers, type ProtocolHandlers } from "./create-handlers.js";
import {
  createCronScheduler,
  type CronScheduler,
  type CronSchedulerOptions,
} from "./crons/cron-scheduler.js";
import type { ProtocolDeps } from "./deps.js";
import {
  createIdempotencySweeper,
  type IdempotencySweeper,
  type IdempotencySweeperOptions,
} from "./idempotency/idempotency-sweeper.js";
import { createIdempotentHandlers } from "./idempotency/idempotent-handlers.js";
import { createRunWorker, type RunWorker, type RunWorkerOptions } from "./runs/run-worker.js";
import { createProtocolServiceFromContext, type ProtocolService } from "./service.js";
import {
  createThreadTtlSweeper,
  type ThreadTtlSweeper,
  type ThreadTtlSweeperOptions,
} from "./threads/thread-ttl-sweeper.js";

/** Options for {@link createProtocolRuntime}. */
export interface ProtocolRuntimeOptions {
  /** Tuning for the background run worker (max concurrency, shutdown grace period). */
  worker?: RunWorkerOptions;
  /** Tuning for the cron scheduler (tick interval, batch size, or `enabled: false` to switch it off). */
  scheduler?: CronSchedulerOptions;
  /**
   * Cadence for the thread TTL sweep. The sweeper runs either way — a per-thread `ttl` needs
   * collecting whether or not the server sets a default — so this only tunes how often, not whether.
   */
  threadTtl?: ThreadTtlSweeperOptions;
  /**
   * Cadence for the idempotency-record sweep. Like the thread sweep, this tunes how often, not
   * whether — a caller can send `Idempotency-Key` whatever the server configured.
   */
  idempotencySweep?: IdempotencySweeperOptions;
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
  /**
   * The loop that collects threads whose TTL has expired.
   *
   * Always present, like {@link ProtocolRuntime.scheduler} — a caller can set a per-thread `ttl` on
   * `POST /threads` with no `checkpointer.ttl` configured at all, and something has to collect it.
   * Started and stopped alongside the worker; exposed for a host that wants to drive `sweepOnce()`
   * itself.
   */
  threadTtlSweeper: ThreadTtlSweeper;
  /**
   * The loop that reclaims idempotency records past their retention.
   *
   * Always present for the same reason as {@link ProtocolRuntime.threadTtlSweeper}. Unlike the
   * others, nothing depends on it running: a claim takes over an expired record itself, so a server
   * whose sweeper never ticked is carrying dead rows, not answering wrongly.
   */
  idempotencySweeper: IdempotencySweeper;
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
  // Resolved before the context is built, so `GET /info` reports what this server actually serves
  // rather than what the engine can do in principle.
  const cronsEnabled = options.scheduler?.enabled ?? deps.cronsEnabled ?? true;
  const context = createContext({ ...deps, cronsEnabled });
  const service = createProtocolServiceFromContext(context);
  // When an auth engine is injected, every request is authenticated + authorized through one
  // transport-neutral seam; without it, the handler table is unchanged (unauthenticated, as before).
  const authorized = deps.auth
    ? createAuthorizingHandlers(context, deps.auth)
    : createProtocolHandlers(service);
  // Idempotency wraps the authorizing table from **outside**, because a key's scope has to include
  // the principal — without it, one tenant guessing another's key would be handed that tenant's
  // recorded response. The cost is one extra `authenticate` on requests that actually carry a key
  // (a request without the header pays a single header lookup and dispatches straight through), and
  // it is correct by construction on the way in: a claim taken before a 401 is released when the
  // inner table throws, so an unauthenticated caller cannot pin a key.
  //
  // It reads the *base* store deliberately, not the per-request auth-scoped one: the scope string
  // already carries the principal, so a second ownership filter would only be able to disagree.
  const authEngine = deps.auth;
  const handlers = createIdempotentHandlers(authorized, {
    store: context.deps.store,
    clock: context.deps.clock,
    logger: context.deps.logger,
    ...(deps.idempotency ?? {}),
    ...(authEngine
      ? {
          principalFor: async (req) => (await resolveAuthContext(authEngine, req))?.user.identity,
        }
      : {}),
  });
  const worker = createRunWorker(context, options.worker);
  const scheduler = createCronScheduler(context, options.scheduler);
  // Always built, NOT gated on `checkpointer.ttl` being configured. A per-thread `ttl` on
  // `POST /threads` sets an expiry whether or not the server has a default, so gating the loop on the
  // config block would validate that field, write `expires_at`, and then let the thread live forever
  // — the same accepted-and-silently-ignored shape this whole surface exists to remove.
  //
  // Cheap when unused: `listExpired` is one indexed read that returns nothing, on an unref'd hourly
  // timer. `checkpointer.ttl` supplies the *default lifetime* and the cadence, not permission to run.
  //
  // Options win over deps, matching how `scheduler.enabled` treats `deps.cronsEnabled`: an explicit
  // option is a decision by whoever built the runtime, where the deps carry what the config said.
  const threadTtlSweeper = createThreadTtlSweeper(
    // `context.deps`, not the raw `deps`: the logger is defaulted there, like every other
    // background loop's.
    { store: context.deps.store, threads: service.threads, logger: context.deps.logger },
    options.threadTtl ??
      (deps.threadTtl?.sweepIntervalMinutes !== undefined
        ? { sweepIntervalMinutes: deps.threadTtl.sweepIntervalMinutes }
        : {}),
  );
  // Always built, for the same reason the thread sweeper is: a caller can send `Idempotency-Key`
  // whether or not the server configured a retention, and the records it writes have to be
  // collected. Cheap when unused — one `DELETE` matching nothing, on an unref'd hourly timer.
  const idempotencySweeper = createIdempotencySweeper(
    { store: context.deps.store, logger: context.deps.logger },
    options.idempotencySweep ??
      (deps.idempotency?.sweepIntervalMinutes !== undefined
        ? { sweepIntervalMinutes: deps.idempotency.sweepIntervalMinutes }
        : {}),
  );

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
    threadTtlSweeper,
    idempotencySweeper,
    worker: {
      get inFlightRunCount() {
        return worker.inFlightRunCount;
      },
      start: () => {
        worker.start();
        scheduler.start();
        threadTtlSweeper.start();
        idempotencySweeper.start();
      },
      stop: async () => {
        await scheduler.stop();
        // Before the worker drains: a sweep deletes threads, and doing that while runs are still
        // settling would race the very rows they are writing.
        await threadTtlSweeper.stop();
        // Nothing depends on ordering here — an idempotency record references no other row — but it
        // stops with the other sweepers so a torn-down store never has a loop still writing into it.
        await idempotencySweeper.stop();
        await worker.stop();
        await subscription?.close();
      },
    },
  };
}
