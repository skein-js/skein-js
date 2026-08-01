// The cron scheduler: the loop that turns stored schedules into runs.
//
// Every instance runs one. There is no leader election and no distributed lock — a due cron is
// claimed with a single-row conditional UPDATE on its primary key, so if three instances see the
// same occurrence, exactly one wins and the other two skip. Losing is the normal outcome, not an
// error.
//
// The claim and the run row commit *together* (`CronRepo.claimAndCreateRun`), which makes the run row
// a transactional outbox: advancing without the run would silently skip the occurrence if this
// instance died in between, and creating the run first would re-fire it. Committed together, the
// worst case is a `pending` run that was never enqueued — which {@link sweepUnqueuedRuns} below
// re-enqueues. Delivery is therefore at-least-once, and execution exactly-once, because enqueue is
// idempotent (keyed on `run_id`) and the worker skips runs already terminal in the store.
//
// The one thing this loop must never do is stop. A tick that throws or hangs would otherwise end
// scheduling for the life of the process while the server kept reporting healthy — so the next timer
// is scheduled in a `finally`, the catch never rethrows, and each tick runs under a timeout.

import type { Cron, CronAuth, Metadata, SkeinStore } from "@skein-js/core";

import { authFiltersToMetadataSubset } from "../auth/auth-filters-to-metadata.js";
import { createAuthScopedStore } from "../auth/auth-scoped-store.js";
import type { ProtocolContext } from "../context.js";
import { toKwargs } from "../runs/run-service.js";

import { advanceCronOccurrence } from "./cron-schedule.js";

/**
 * How often each instance looks for due crons. 30s keeps worst-case lateness well below the one
 * minute a 5-field expression can even express, at two indexed reads per minute per instance.
 */
export const DEFAULT_CRON_TICK_MS = 30_000;

/**
 * How long a single tick may take before it is abandoned. Generous — a tick firing a full batch does
 * real work — but finite, because a tick that hangs forever takes the whole schedule with it.
 */
export const DEFAULT_CRON_TICK_TIMEOUT_MS = 120_000;

/** Most crons fired per tick. A full batch re-ticks immediately, so a backlog drains in order. */
export const DEFAULT_CRON_BATCH_SIZE = 100;

/**
 * How long a run may sit `pending` before the sweep assumes its enqueue was lost. Comfortably longer
 * than a normal queue wait, so a run merely queued behind a busy worker is never re-enqueued on
 * suspicion — and harmless if it is, since enqueue is idempotent.
 */
export const DEFAULT_UNQUEUED_RUN_GRACE_MS = 300_000;

/** What one tick did. Reported to the logger and the telemetry sink; also the test seam's return. */
export interface CronTickSummary {
  /** Due crons the scan returned. */
  scanned: number;
  /** Occurrences this instance won and enqueued. */
  fired: number;
  /** Occurrences another instance won, or that a concurrent patch invalidated. Not an error. */
  claimsLost: number;
  /** Crons that came due but could not be fired — a missing assistant, a store failure. */
  failed: number;
  /** Crons retired this tick: the occurrence fired, and there is no next one. */
  exhausted: number;
  /** `pending` runs past the grace window that were re-enqueued (the outbox sweep). */
  requeued: number;
  /** The scan filled its batch, so more was due than was fired. Triggers an immediate re-tick. */
  truncated: boolean;
  /**
   * How overdue the most overdue enabled cron is, or `null` when nothing is due.
   *
   * The liveness signal: healthy, it stays under one tick; with a dead scheduler it climbs without
   * bound. Alert on `lagMs > 3 × tick` — it is the one number that distinguishes "no crons are due"
   * from "nothing is running the crons".
   */
  lagMs: number | null;
}

export interface CronSchedulerOptions {
  tickMs?: number;
  tickTimeoutMs?: number;
  batchSize?: number;
  unqueuedRunGraceMs?: number;
  /** False switches the loop off entirely — `http.disable_crons`. `start()` becomes a no-op. */
  enabled?: boolean;
  /**
   * Seed for the one-off startup phase offset, in `[0, 1)`. Injected only so a test is
   * deterministic; production passes nothing and gets `Math.random()`.
   */
  jitterSeed?: number;
}

export interface CronScheduler {
  /** Idempotent. A no-op when the scheduler is disabled. */
  start(): void;
  stop(): Promise<void>;
  /**
   * Run exactly one tick and report what it did.
   *
   * Public because it earns its place three times over: it is the deterministic test seam, it is
   * what lets a truncated scan re-tick immediately instead of waiting out the interval, and it is
   * the hook an external trigger could call on a platform that will not keep a timer alive.
   */
  tickOnce(): Promise<CronTickSummary>;
}

const EMPTY_SUMMARY: CronTickSummary = {
  scanned: 0,
  fired: 0,
  claimsLost: 0,
  failed: 0,
  exhausted: 0,
  requeued: 0,
  truncated: false,
  lagMs: null,
};

/** Reject after `ms`, so a wedged tick cannot hold the loop open forever. */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    // `unref` so a pending timeout never holds the process open on shutdown.
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function createCronScheduler(
  ctx: ProtocolContext,
  options: CronSchedulerOptions = {},
): CronScheduler {
  const { deps } = ctx;
  const tickMs = options.tickMs ?? DEFAULT_CRON_TICK_MS;
  const tickTimeoutMs = options.tickTimeoutMs ?? DEFAULT_CRON_TICK_TIMEOUT_MS;
  const batchSize = options.batchSize ?? DEFAULT_CRON_BATCH_SIZE;
  const unqueuedRunGraceMs = options.unqueuedRunGraceMs ?? DEFAULT_UNQUEUED_RUN_GRACE_MS;
  const enabled = options.enabled ?? true;

  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The in-flight tick, so `stop()` can wait for it rather than cutting it off mid-fire. */
  let inFlightTick: Promise<unknown> | undefined;

  /**
   * The store a cron's runs are created through: the base store, or an ownership-scoped view when
   * an auth engine is configured and the cron has a remembered principal.
   *
   * The filters are **re-derived here**, at fire time, rather than persisted with the cron. Three
   * reasons: a persisted filter freezes the shape, so editing an `@auth.on` handler would leave old
   * crons on old rules; a revoked principal's handler can now deny, which stops that cron producing
   * runs and lets it resume if re-granted; and it reuses the exact `authorize` + `createAuthScopedStore`
   * pair the request path uses, so the two cannot drift.
   *
   * This is load-bearing rather than polish: without the scoped store, a stateless cron's per-fire
   * thread carries no owner stamp, and the user who created the cron cannot see its results in their
   * own `POST /threads/search`.
   */
  const storeForFire = async (
    cron: Cron,
    auth: CronAuth | null,
  ): Promise<{ store: SkeinStore; ownerMetadata: Metadata | undefined }> => {
    if (!deps.auth?.enabled || !auth) return { store: deps.store, ownerMetadata: undefined };
    // A denial here is the point, not a failure: the principal has lost the permission, so this
    // occurrence produces nothing. Propagated so the caller records it and moves the cron on.
    const { filters } = await deps.auth.authorize({
      resource: "threads",
      action: "create_run",
      value: { assistant_id: cron.assistant_id, thread_id: cron.thread_id ?? undefined },
      context: { user: auth.user, scopes: auth.scopes ?? [] },
    });
    return {
      store: createAuthScopedStore(deps.store, deps.auth, filters, "threads"),
      // The owner tag the scoped store would stamp on a write, surfaced so the *run* can carry it
      // too. The run is created inside `claimAndCreateRun` — a cron-repo method, which the scoped
      // store inherits unfiltered — so it never passes through the decorator's `runs.create`
      // stamping. Without this the creator's own `GET /threads/{id}/runs` cannot see the runs their
      // schedule produced, which is the promise in docs/crons.md.
      ownerMetadata: authFiltersToMetadataSubset(filters),
    };
  };

  /**
   * Fire one due cron: resolve its thread, claim the occurrence, and enqueue the run.
   *
   * Returns what happened so the tick can total it up. A `"lost"` result is the ordinary
   * multi-instance outcome and is deliberately not logged at anything above debug.
   */
  const fireCron = async (
    cron: Cron,
    occurrenceSeq: number,
    nextRunDate: string | null,
  ): Promise<{ outcome: "fired"; runId: string } | { outcome: "lost" }> => {
    const auth = await deps.store.crons.getAuth(cron.cron_id);
    const { store: fireStore, ownerMetadata } = await storeForFire(cron, auth);
    const stateless = cron.thread_id == null;

    // A stateless cron gets a fresh thread per fire. Created before the claim because the run row
    // references it, and removed again if the claim is lost — cheap, and only reachable when two
    // instances tick the same occurrence at once.
    const thread = stateless
      ? await fireStore.threads.create({
          // Stamped so `runs.search({ metadata: { cron_id } })` finds a schedule's output, which is
          // the documented way to trace what a cron has produced.
          metadata: { cron_id: cron.cron_id },
        })
      : await deps.store.threads.get(cron.thread_id as string);

    // Only reachable if the thread vanished between the scan and now; the FK cascade means a
    // deleted thread normally takes its cron with it.
    if (!thread) throw new Error(`thread "${cron.thread_id}" not found`);

    const payload = cron.payload as Record<string, unknown>;
    const kwargs = toKwargs(
      {
        ...payload,
        assistant_id: cron.assistant_id,
        thread_id: stateless ? undefined : (cron.thread_id as string),
        // Resolved at create time and persisted on the row, so the wire always said what would
        // happen. Only meaningful for the thread this fire created.
        on_completion: stateless ? (cron.on_run_completed ?? "delete") : undefined,
      },
      stateless,
      auth?.user,
      auth?.scopes,
    );

    const claimed = await deps.store.crons.claimAndCreateRun(
      cron.cron_id,
      { expectedSeq: occurrenceSeq, nextRunDate },
      {
        thread_id: thread.thread_id,
        assistant_id: cron.assistant_id,
        status: "pending",
        // `cron_id` on the run is the documented trace key, and it is also what the worker reads to
        // report this run's trigger as `cron` rather than `background`.
        //
        // The owner tag rides along because the run is created inside `claimAndCreateRun` — a
        // cron-repo method, which the scoped store inherits unfiltered — so it never passes through
        // the decorator's `runs.create` stamping. Without it, an auth-scoped deployment's creator
        // could not see the runs their own schedule produced.
        metadata: {
          ...ownerMetadata,
          cron_id: cron.cron_id,
        },
        // Thread crons queue behind an active run rather than 422ing, matching LangGraph's
        // `ThreadCronCreate` default — a schedule landing on a busy thread should wait, not fail.
        multitask_strategy: stateless
          ? undefined
          : ((payload["multitask_strategy"] as never) ?? "enqueue"),
        kwargs,
      },
    );

    if (!claimed) {
      // Another instance won. Take back the thread this fire speculatively created, best-effort:
      // failing to clean up leaves a stray empty thread, which is not worth failing the tick over.
      if (stateless) {
        await fireStore.threads.delete(thread.thread_id).catch(() => undefined);
      }
      return { outcome: "lost" };
    }

    // After the commit, deliberately. A failure here leaves a `pending` run row that the sweep
    // re-enqueues — which is the whole point of committing the claim and the run together.
    await deps.queue.enqueue({ run_id: claimed.run.run_id, thread_id: claimed.run.thread_id });
    return { outcome: "fired", runId: claimed.run.run_id };
  };

  /**
   * Re-enqueue runs that were committed but never made it onto the queue — the outbox sweep.
   *
   * This is what turns the claim's at-most-once into at-least-once: a crash between the transaction
   * and the enqueue leaves durable evidence (a `pending` run row), and this finds it. Safe to run
   * against a run that *is* queued, because enqueue is idempotent on `run_id` and the worker skips
   * runs already terminal in the store.
   *
   * Not cron-specific: it covers every background run, which has always had the same window between
   * `prepareRun` and `enqueueBackgroundRun`. The scheduler owns it only because it is the loop that
   * is already running.
   */
  const sweepUnqueuedRuns = async (
    now: Date,
    justEnqueued: ReadonlySet<string>,
  ): Promise<number> => {
    const staleBefore = now.getTime() - unqueuedRunGraceMs;
    let requeued = 0;
    // `listActiveRuns()` with no thread reads the inflight partial index and is page-bounded, so
    // this cannot pull an unbounded backlog into memory.
    for (const run of await deps.store.runs.listActiveRuns()) {
      // `running` is excluded: a run the engine has picked up is not lost, and re-enqueueing it
      // could hand a second worker the same run before it settles.
      if (run.status !== "pending") continue;
      // A run this very tick enqueued is not lost by definition — and its `created_at` comes from
      // the store's clock while `now` comes from ours, so on any skew it would otherwise look stale
      // the instant it was written.
      if (justEnqueued.has(run.run_id)) continue;
      if (Date.parse(run.created_at) > staleBefore) continue;
      await deps.queue.enqueue({ run_id: run.run_id, thread_id: run.thread_id });
      requeued += 1;
      deps.logger.warn(
        `run ${run.run_id} was pending with no queue entry for over ${unqueuedRunGraceMs}ms; re-enqueued.`,
      );
    }
    return requeued;
  };

  const tickOnce = async (): Promise<CronTickSummary> => {
    const now = deps.clock();
    const due = await deps.store.crons.listDue({ dueAt: now.toISOString(), limit: batchSize });
    const summary: CronTickSummary = {
      ...EMPTY_SUMMARY,
      scanned: due.length,
      truncated: due.length >= batchSize,
    };

    // Run ids this tick put on the queue, so its own sweep does not treat them as lost.
    const justEnqueued = new Set<string>();

    for (const { cron, occurrenceSeq } of due) {
      // Where this cron points *after* this occurrence. Computed from the later of its stored date
      // and now, so a cron that fell an hour behind lands in the future in one step rather than
      // replaying the whole outage — see `advanceCronOccurrence`.
      const nextRunDate = advanceCronOccurrence({
        schedule: cron.schedule,
        timezone: cron.timezone,
        endTime: cron.end_time,
        from: cron.next_run_date ?? now.toISOString(),
        now,
      });

      try {
        const result = await fireCron(cron, occurrenceSeq, nextRunDate);
        if (result.outcome === "fired") {
          summary.fired += 1;
          justEnqueued.add(result.runId);
          if (nextRunDate === null) summary.exhausted += 1;
        } else {
          summary.claimsLost += 1;
        }
      } catch (error) {
        summary.failed += 1;
        // Logged at error and counted, but the cron stays enabled and still advances below.
        // Auto-disabling would turn a 30-second rolling-deploy blip into a silently stopped
        // schedule that needs a human to notice; the next occurrence is the retry, and its natural
        // backoff. A retry loop here against a permanently missing assistant would be a hot loop.
        deps.logger.error(`cron ${cron.cron_id} failed to fire; it stays enabled and will retry.`, {
          cron_id: cron.cron_id,
          assistant_id: cron.assistant_id,
          thread_id: cron.thread_id,
          schedule: cron.schedule,
          error: error instanceof Error ? error.message : String(error),
        });
        // Advance anyway. Leaving `next_run_date` in the past would re-select this cron on every
        // tick forever, and the batch it occupies would starve the crons behind it.
        await deps.store.crons
          .claimNextRun(cron.cron_id, { expectedSeq: occurrenceSeq, nextRunDate })
          .catch(() => undefined);
      }
    }

    summary.requeued = await sweepUnqueuedRuns(now, justEnqueued);
    // Read after the fires, so it reports the backlog that remains rather than the one just cleared.
    summary.lagMs = await deps.store.crons.maxOverdueMs(deps.clock().toISOString());
    return summary;
  };

  const reportTick = (summary: CronTickSummary): void => {
    if (summary.fired > 0 || summary.failed > 0 || summary.requeued > 0) {
      deps.logger.info("cron tick", summary);
    }
  };

  /**
   * The loop. Its single most important property is that it always schedules the next tick:
   * the reschedule is in a `finally` and the catch never rethrows, so no failure mode ends
   * scheduling for the life of the process while the server goes on reporting healthy.
   */
  const loop = async (): Promise<void> => {
    let truncated = false;
    try {
      const summary = await withTimeout(tickOnce(), tickTimeoutMs, "cron tick");
      reportTick(summary);
      truncated = summary.truncated;
    } catch (error) {
      deps.logger.error("cron tick failed; the scheduler continues.", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (running) {
        // A full batch means more was due than fired, so drain immediately instead of leaving the
        // backlog to trickle out one batch per interval.
        timer = setTimeout(runLoop, truncated ? 0 : tickMs);
        timer.unref?.();
      }
    }
  };

  const runLoop = (): void => {
    inFlightTick = loop();
  };

  return {
    tickOnce,

    start() {
      if (!enabled || running) return;
      running = true;
      if (deps.store.durable === false) {
        deps.logger.warn(
          "crons are stored in a non-durable store: every schedule is lost when this process exits. " +
            "Use the postgres store to persist them (`skein dev` snapshots them to .skein/ instead).",
        );
      }
      // The period is fixed; only the *phase* is jittered, once. A rolling deploy boots every
      // replica within a second of the others, so unjittered they tick in lockstep and every tick is
      // an N-way race for the same rows. One offset de-phases them for good, where re-jittering each
      // period would make the cadence drift without actually decorrelating them.
      //
      // This is a load optimisation, NOT a correctness measure: the compare-and-swap makes
      // contention harmless, not merely rare. Nothing here depends on the jitter.
      const phase = Math.floor((options.jitterSeed ?? Math.random()) * tickMs);
      timer = setTimeout(runLoop, phase);
      timer.unref?.();
    },

    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      // Wait out a tick already in flight so `stop()` resolving means nothing is still firing. It
      // cannot reject — `loop` swallows its own failures — so this needs no catch.
      await inFlightTick;
      inFlightTick = undefined;
    },
  };
}
