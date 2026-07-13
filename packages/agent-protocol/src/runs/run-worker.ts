// The background worker: pulls queued runs and executes them through the same engine as inline
// runs. It only ever talks to the injected `RunQueue`/`RunEventBus`, so swapping the in-memory
// queue for `@skein-js/redis` (blocking `dequeue`, lease-based reclaim) needs no change here.

import { isTerminalRunStatus } from "@skein-js/core";

import type { ProtocolContext } from "../context.js";

import { executeRun } from "./run-engine.js";

export interface RunWorkerOptions {
  /** Max runs executing at once. Default 1 — strict per-thread serialization in dev. */
  maxConcurrency?: number;
  /** How long to wait before re-polling an empty in-memory queue (ms). Default 50. */
  pollIntervalMs?: number;
  /** How long `stop()` waits for in-flight runs before aborting them (ms). Default 5000. */
  shutdownGraceMs?: number;
}

export interface RunWorker {
  /** Begin pulling and executing queued runs. Idempotent. */
  start(): void;
  /** Stop pulling; drain in-flight runs, then abort any still running past the grace deadline. */
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createRunWorker(ctx: ProtocolContext, options: RunWorkerOptions = {}): RunWorker {
  const { deps, control } = ctx;
  const maxConcurrency = options.maxConcurrency ?? 1;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const shutdownGraceMs = options.shutdownGraceMs ?? 5000;

  const inFlight = new Map<string, Promise<void>>();
  let running = false;
  let loop: Promise<void> | undefined;

  const execute = async (runId: string): Promise<void> => {
    const run = await deps.store.runs.get(runId);
    // Skip a run that vanished (thread deleted) or was already finalized (cancelled while queued).
    if (!run || isTerminalRunStatus(run.status)) return;
    const kwargs = (await deps.store.runs.getKwargs(runId)) ?? {};
    const runControl = control.register(runId);
    try {
      await executeRun(deps, { run, kwargs, control: runControl });
    } finally {
      control.clear(runId);
    }
  };

  const dispatch = (runId: string): void => {
    const task = execute(runId)
      .catch((error: unknown) => deps.logger.error("background run failed", error))
      .finally(() => {
        inFlight.delete(runId);
      });
    inFlight.set(runId, task);
  };

  const runLoop = async (): Promise<void> => {
    while (running) {
      if (inFlight.size >= maxConcurrency) {
        await Promise.race(inFlight.values());
        continue;
      }
      const queued = await deps.queue.dequeue();
      // `running` may have flipped false while we awaited dequeue. Don't start a run during
      // shutdown — put it back so the drain snapshot is complete and the job isn't lost.
      if (!running) {
        if (queued) await deps.queue.enqueue(queued);
        break;
      }
      if (!queued) {
        await sleep(pollIntervalMs);
        continue;
      }
      dispatch(queued.run_id);
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      loop = runLoop();
    },

    async stop() {
      // Stop pulling new work. Don't await the loop yet — it may be parked on an in-flight run;
      // draining/aborting below is what lets it unblock and exit.
      running = false;

      // Give in-flight runs the grace window to finish on their own.
      const timedOut = Symbol("timeout");
      const drained = Promise.all(inFlight.values()).then(() => "drained" as const);
      const outcome = await Promise.race([drained, sleep(shutdownGraceMs).then(() => timedOut)]);

      if (outcome === timedOut) {
        // Abort whatever is still running, then wait for those runs to settle terminally.
        for (const runId of inFlight.keys()) control.abort(runId, "cancel");
        await Promise.all(inFlight.values());
      }

      // In-flight is now empty, so the loop's `Promise.race`/poll unblocks and sees `running=false`.
      await loop;
    },
  };
}
