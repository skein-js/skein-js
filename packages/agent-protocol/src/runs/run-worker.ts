// The background worker: registers a processor with the injected `RunQueue` that executes each
// queued run through the same engine as inline runs. It only ever talks to the `RunQueue`
// interface, so swapping the in-memory queue for `@skein-js/redis` (BullMQ) needs no change here.

import { isTerminalRunStatus, type QueuedRun, type RunConsumer } from "@skein-js/core";

import type { ProtocolContext } from "../context.js";

import { executeRun } from "./run-engine.js";

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

export function createRunWorker(ctx: ProtocolContext, options: RunWorkerOptions = {}): RunWorker {
  const { deps, control } = ctx;
  const maxConcurrency = options.maxConcurrency ?? 1;
  const shutdownGraceMs = options.shutdownGraceMs ?? 5000;

  // runIds currently executing on this worker, so shutdown can abort the stragglers.
  const inFlight = new Set<string>();

  const process = async (queued: QueuedRun): Promise<void> => {
    const run = await deps.store.runs.get(queued.run_id);
    // Skip a run that vanished (thread deleted) or was already finalized (cancelled while queued).
    if (!run || isTerminalRunStatus(run.status)) return;
    const kwargs = (await deps.store.runs.getKwargs(queued.run_id)) ?? {};
    const runControl = control.register(queued.run_id);
    inFlight.add(queued.run_id);
    try {
      await executeRun(deps, { run, kwargs, control: runControl });
    } finally {
      control.clear(queued.run_id);
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
