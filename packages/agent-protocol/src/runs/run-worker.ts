// The background worker: registers a processor with the injected `RunQueue` that executes each
// queued run through the same engine as inline runs. It only ever talks to the `RunQueue`
// interface, so swapping the in-memory queue for `@skein-js/redis` (BullMQ) needs no change here.

import {
  isTerminalRunStatus,
  toRunError,
  type QueuedRun,
  type Run,
  type RunConsumer,
  type RunError,
  type RunStatus,
} from "@skein-js/core";

import type { ProtocolContext } from "../context.js";
import type { Logger } from "../deps.js";

import { startRunExecution } from "./run-execution.js";

/**
 * Queued runs one worker executes at once when nothing is configured. Matches the LangGraph CLI's
 * `--n-jobs-per-worker` default, so a project moving off `langgraph dev` keeps its throughput.
 */
export const DEFAULT_RUN_CONCURRENCY = 10;

/**
 * How long `stop()` lets in-flight runs finish before aborting them. Chosen to leave room inside the
 * tightest common stop window — a container platform typically sends SIGTERM and SIGKILLs ~10s later
 * (Cloud Run's default; `docker stop`'s too) — for this drain *plus* the abort-and-settle step that
 * follows it. Raise it via `SKEIN_SHUTDOWN_GRACE_MS` where the platform allows a longer window
 * (Railway, Kubernetes' `terminationGracePeriodSeconds`, ECS `stopTimeout`); the host must also wait
 * longer than this before forcing exit, or the abort path never runs. See docs/deploy.md.
 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 5000;

export interface RunWorkerOptions {
  /**
   * Max queued runs this worker executes at once. Default {@link DEFAULT_RUN_CONCURRENCY}.
   * Per-thread ordering does not depend on this: `startRunExecution` serializes by `thread_id` at
   * every value. The trade-off is head-of-line blocking — a run waiting on a busy thread's lock
   * still holds a slot, so a burst of `multitask_strategy: "enqueue"` runs on one thread can occupy
   * the worker. See docs/runs-and-redis.md.
   */
  maxConcurrency?: number;
  /**
   * How long `stop()` waits for in-flight runs before aborting them (ms). Default
   * {@link DEFAULT_SHUTDOWN_GRACE_MS}.
   */
  shutdownGraceMs?: number;
}

export interface RunWorker {
  /** Begin consuming and executing queued runs. Idempotent. */
  start(): void;
  /** Stop consuming; drain in-flight runs, then abort any still running past the grace deadline. */
  stop(): Promise<void>;
}

/**
 * A delay that can be cancelled. `stop()` races this against the drain, so the timer has to be
 * cleared once the race settles — an uncancelled one keeps the event loop alive for the whole grace
 * window after an otherwise instant shutdown, which an embedded host (no force-exit timer of its
 * own) would experience as a hang.
 */
function cancellableDelay(ms: number): { readonly elapsed: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { elapsed, cancel: () => clearTimeout(timer) };
}

/**
 * A per-run lifecycle summary for background runs, mirroring `langgraph dev`. Emitted through the
 * injected logger as a message plus structured meta (the CLI dev logger renders it); production
 * injects a no-op logger, so this costs nothing there. The timing fields are computed here — the
 * wire `Run` carries only `created_at`, not `started_at`/`ended_at`/durations.
 */
function logRunLifecycle(
  logger: Logger,
  run: Run,
  status: RunStatus,
  startedAt: number,
  endedAt: number,
  failure?: RunError,
): void {
  const message = status === "success" ? "Background run succeeded" : `Background run ${status}`;
  const meta = {
    run_id: run.run_id,
    // A summary that says a run failed but not why sends you hunting through the log for the
    // engine's report. The full stack stays there; this is the breadcrumb.
    ...(failure ? { run_error: `${failure.name}: ${failure.message}` } : {}),
    run_attempt: 1,
    run_created_at: run.created_at,
    run_started_at: new Date(startedAt).toISOString(),
    run_ended_at: new Date(endedAt).toISOString(),
    run_exec_ms: endedAt - startedAt,
    run_queue_ms: startedAt - Date.parse(run.created_at),
  };
  // Called, not passed as a reference, so a class-based logger keeps its `this`.
  if (status === "error" || status === "timeout") logger.error(message, meta);
  else logger.info(message, meta);
}

export function createRunWorker(ctx: ProtocolContext, options: RunWorkerOptions = {}): RunWorker {
  const { deps, control } = ctx;
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_RUN_CONCURRENCY;
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

  // runIds currently executing on this worker, so shutdown can abort the stragglers.
  const inFlight = new Set<string>();

  // The executions themselves, so shutdown can wait for an aborted run to actually reach a terminal
  // status. `inFlight` only names them — awaiting is the difference between `stop()` meaning
  // "signalled" and meaning "settled".
  const running = new Set<Promise<unknown>>();

  const executeQueuedRun = (queued: QueuedRun): Promise<void> => {
    const task = executeOne(queued);
    running.add(task);
    return task.finally(() => running.delete(task));
  };

  const executeOne = async (queued: QueuedRun): Promise<void> => {
    const run = await deps.store.runs.get(queued.run_id);
    // Skip a run that vanished (thread deleted) or was already finalized (cancelled while queued).
    // Such a run never reaches startRunExecution, so drop any rollback plan it carried rather than
    // leak it in the map.
    if (!run || isTerminalRunStatus(run.status)) {
      ctx.rollbackPlans.delete(queued.run_id);
      return;
    }
    const kwargs = (await deps.store.runs.getKwargs(queued.run_id)) ?? {};
    inFlight.add(queued.run_id);
    // Wall-clock timing for the human-facing summary, so queue/exec durations line up with the
    // store-stamped `run.created_at`. Defaults to `error` so a run whose execution *throws* (not just
    // one that returns a terminal error status) is still summarised before the throw propagates.
    // `startRunExecution` owns the per-thread execution lock, cancellation control, base-checkpoint
    // capture, and any pending rollback — the same path inline runs take, so behavior can't drift.
    const startedAt = Date.now();
    let status: RunStatus = "error";
    let failure: RunError | undefined;
    try {
      // `queuedAtMs` is the run's `created_at` — the same instant `run_queue_ms` measures from, so
      // the log summary and the telemetry event report one number, not two that nearly agree.
      const queuedAtMs = Date.parse(run.created_at);
      const outcome = await startRunExecution(ctx, run, kwargs, {
        trigger: "background",
        ...(Number.isNaN(queuedAtMs) ? {} : { queuedAtMs }),
      });
      status = outcome.status;
      failure = outcome.error;
    } catch (error) {
      // `executeRun` swallows graph errors, so a throw here is a store/precondition failure. It used
      // to vanish into the queue's retry with no trace; record it before letting it propagate.
      failure = toRunError(error);
      throw error;
    } finally {
      logRunLifecycle(deps.logger, run, status, startedAt, Date.now(), failure);
      inFlight.delete(queued.run_id);
    }
  };

  let consumer: RunConsumer | undefined;

  return {
    start() {
      if (consumer) return;
      consumer = deps.queue.consume(executeQueuedRun, { concurrency: maxConcurrency });
    },

    async stop() {
      if (!consumer) return;
      const active = consumer;
      consumer = undefined;

      // Race a graceful drain against the grace deadline. Aborting a straggler makes its
      // `executeRun` settle terminally, so the same graceful close then resolves — no force needed.
      //
      // The drain's own failure must never short-circuit that abort. If the queue connection is
      // already gone — routine on shutdown, when the Redis container is torn down before this one —
      // `close()` rejects, and the abort below is then the only thing that still settles in-flight
      // runs terminally. So the rejection is captured rather than thrown: `graceful` always
      // fulfills, the race can't propagate, and `drained` stays false so the abort runs.
      let drained = false;
      let drainFailure: unknown;
      const graceful = active.close().then(
        () => {
          drained = true;
        },
        (error: unknown) => {
          drainFailure = error;
        },
      );
      const deadline = cancellableDelay(shutdownGraceMs);
      try {
        await Promise.race([graceful, deadline.elapsed]);
      } finally {
        deadline.cancel();
      }
      if (!drained) {
        for (const runId of inFlight) control.abort(runId, "cancel");
        await graceful;
        // `graceful` may have *failed* rather than completed, in which case nothing above waited for
        // the aborted runs to unwind and write their terminal status. Wait for them here, so a
        // resolved `stop()` always means the store is consistent.
        await Promise.allSettled([...running]);
      }
      if (drainFailure !== undefined) {
        // Surfaced, not rethrown: `stop()` is best-effort teardown, and its caller is a signal
        // handler whose job is to exit cleanly regardless.
        deps.logger.warn("Run queue did not close cleanly during shutdown", {
          error: drainFailure instanceof Error ? drainFailure.message : String(drainFailure),
        });
      }

      // Last, once every run has settled: drain buffered telemetry, so a batching exporter doesn't
      // lose the tail — precisely the events you most want after a crash.
      //
      // `flush` only, never `shutdown`: the worker did not build these sinks and does not own their
      // lifetime. A host can stop the worker while continuing to serve inline `wait`/`stream` runs,
      // and closing the underlying client here would silently drop every event for the rest of the
      // process. Whoever assembled the sinks closes them (see `buildRuntime`'s `dispose`).
      if (deps.telemetryEnabled) await deps.telemetry.flush?.();
    },
  };
}
