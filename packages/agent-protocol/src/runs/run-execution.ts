// The one execution entry point every run mode funnels through — wait/stream (inline, via the run
// service) and background (via the worker) alike. It serializes execution per thread (so a second
// run waits its turn — this is what `multitask_strategy: "enqueue"` relies on), applies any pending
// `rollback` plan once the displaced run has released the lock, registers the run's cancellation
// control, and records its base checkpoint for a future rollback.

import type { RunKwargs, Run } from "@skein-js/core";

import type { ProtocolContext } from "../context.js";
import { rollbackThreadCheckpointsTo } from "../threads/checkpoint-history.js";

import { executeRun, type RunOutcome } from "./run-engine.js";

export async function startRunExecution(
  ctx: ProtocolContext,
  run: Run,
  kwargs: RunKwargs,
): Promise<RunOutcome> {
  const { deps, control, executionLocks, runBaseCheckpoints, rollbackPlans } = ctx;
  const runId = run.run_id;
  const threadId = run.thread_id;

  // Register the cancellation control *before* waiting on the execution lock, so a cancel or a worker
  // shutdown that arrives while this run is still queued behind the active run can abort it — not
  // only once it starts executing.
  const runControl = control.register(runId);
  try {
    // Serialize per thread: a second run on a busy thread blocks here until the active run's
    // execution (below) settles and releases the lock — giving enqueue its ordering and letting an
    // interrupt/rollback run start only after the run it displaced has fully stopped.
    return await executionLocks.run(threadId, async () => {
      // A `rollback` run drops the displaced run's writes now that it has settled (we hold the lock
      // it released), then removes its row so the run "never happened". Best-effort on the checkpoint
      // side — a failure to revert must not strand the new run.
      const plan = rollbackPlans.get(runId);
      if (plan) {
        rollbackPlans.delete(runId);
        if (plan.revertToCheckpoint !== false) {
          try {
            await rollbackThreadCheckpointsTo(
              deps.checkpointer,
              threadId,
              plan.revertToCheckpoint.baseCheckpointId,
            );
          } catch (error) {
            deps.logger.warn(`run ${runId}: rollback of displaced writes failed`, error);
          }
        }
        for (const displacedId of plan.displacedRunIds) {
          try {
            await deps.store.runs.delete(displacedId);
          } catch {
            // already gone — nothing to do
          }
        }
      }

      return await executeRun(deps, {
        run,
        kwargs,
        control: runControl,
        recordBaseCheckpoint: (base) => runBaseCheckpoints.set(runId, base),
      });
    });
  } finally {
    control.clear(runId);
    runBaseCheckpoints.delete(runId);
  }
}
