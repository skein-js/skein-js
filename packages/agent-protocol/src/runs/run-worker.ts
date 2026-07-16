// The background worker: registers a processor with the injected `RunQueue` that executes each
// queued run through the same engine as inline runs. It only ever talks to the `RunQueue`
// interface, so swapping the in-memory queue for `@skein-js/redis` (BullMQ) needs no change here.

import {
  isTerminalRunStatus,
  type QueuedRun,
  type Run,
  type RunConsumer,
  type RunStatus,
} from "@skein-js/core";

import type { ProtocolContext } from "../context.js";
import type { Logger } from "../deps.js";

import { startRunExecution } from "./run-execution.js";

export interface RunWorkerOptions {
  /** Max runs executing at once. Default 1 — strict per-thread serialization in dev. */
  maxConcurrency?: number;
  /** How long `stop()` waits for in-flight runs before aborting them (ms). Default 5000. */
  shutdownGraceMs?: number;
}

export interface RunWorker {
  /** Begin consuming and executing queued runs. Idempotent. */
  start(): void;
  /** Stop consuming; drain in-flight runs, then abort any still running past the grace deadline. */
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
): void {
  logger.info(status === "success" ? "Background run succeeded" : `Background run ${status}`, {
    run_id: run.run_id,
    run_attempt: 1,
    run_created_at: run.created_at,
    run_started_at: new Date(startedAt).toISOString(),
    run_ended_at: new Date(endedAt).toISOString(),
    run_exec_ms: endedAt - startedAt,
    run_queue_ms: startedAt - Date.parse(run.created_at),
  });
}

export function createRunWorker(ctx: ProtocolContext, options: RunWorkerOptions = {}): RunWorker {
  const { deps, control } = ctx;
  const maxConcurrency = options.maxConcurrency ?? 1;
  const shutdownGraceMs = options.shutdownGraceMs ?? 5000;

  // runIds currently executing on this worker, so shutdown can abort the stragglers.
  const inFlight = new Set<string>();

  const process = async (queued: QueuedRun): Promise<void> => {
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
    try {
      status = (await startRunExecution(ctx, run, kwargs)).status;
    } finally {
      logRunLifecycle(deps.logger, run, status, startedAt, Date.now());
      inFlight.delete(queued.run_id);
    }
  };

  let consumer: RunConsumer | undefined;

  return {
    start() {
      if (consumer) return;
      consumer = deps.queue.consume(process, { concurrency: maxConcurrency });
    },

    async stop() {
      if (!consumer) return;
      const active = consumer;
      consumer = undefined;

      // Race a graceful drain against the grace deadline. Aborting a straggler makes its
      // `executeRun` settle terminally, so the same graceful close then resolves — no force needed.
      let drained = false;
      const graceful = active.close().then(() => {
        drained = true;
      });
      await Promise.race([graceful, sleep(shutdownGraceMs)]);
      if (!drained) {
        for (const runId of inFlight) control.abort(runId, "cancel");
        await graceful;
      }
    },
  };
}
