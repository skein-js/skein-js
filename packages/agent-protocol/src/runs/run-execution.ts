// The one execution entry point every run mode funnels through — wait/stream (inline, via the run
// service) and background (via the worker) alike. It serializes execution per thread (so a second
// run waits its turn — this is what `multitask_strategy: "enqueue"` relies on), applies any pending
// `rollback` plan once the displaced run has released the lock, registers the run's cancellation
// control, and records its base checkpoint for a future rollback.

import type { RunKwargs, Run, RunTrigger } from "@skein-js/core";

import type { ProtocolContext } from "../context.js";
import { rollbackThreadCheckpointsTo } from "../threads/checkpoint-history.js";

import { executeRun, type RunOutcome } from "./run-engine.js";

/** Telemetry-only context about how this run was started. Omitted entirely by callers that don't care. */
export interface RunExecutionOrigin {
  trigger?: RunTrigger;
  /** When the run was enqueued, epoch ms — background runs only, for queue-latency reporting. */
  queuedAtMs?: number;
}

export async function startRunExecution(
  ctx: ProtocolContext,
  run: Run,
  kwargs: RunKwargs,
  origin: RunExecutionOrigin = {},
): Promise<RunOutcome> {
  const { deps, control, executionLocks, runBaseCheckpoints, rollbackPlans } = ctx;
  const runId = run.run_id;
  const threadId = run.thread_id;

  // Register the cancellation control *before* waiting on the execution lock, so a cancel or a worker
  // shutdown that arrives while this run is still queued behind the active run can abort it — not
  // only once it starts executing.
  const runControl = control.register(runId);
  // Set by the engine while it holds the lock, awaited in the `finally` below. Declared out here
  // because the engine hands it over from its own `finally`, which runs on the failure path too.
  let deliverWebhook: (() => Promise<void>) | undefined;
  try {
    // Serialize per thread: a second run on a busy thread blocks here until the active run's
    // execution (below) settles and releases the lock — giving enqueue its ordering and letting an
    // interrupt/rollback run start only after the run it displaced has fully stopped.
    const outcome = await executionLocks.run(threadId, async () => {
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
            // `error`, not `warn`: the run continues on state that should have been reverted, so the
            // displaced run's writes are still in the thread's history. That is a correctness outcome,
            // not a slow path — and it became reachable in ordinary operation once a statement timeout
            // arrived, because reading a large thread's checkpoint history is one unbounded query.
            // Nothing is destroyed (the read precedes the delete), but the caller has to know.
            deps.logger.error(
              `run ${runId}: rollback of the displaced run's writes failed — this run is continuing ` +
                `on state that was not reverted. On a very large thread, raise ` +
                `PG_STATEMENT_TIMEOUT_MS or use a different multitask_strategy.`,
              error,
            );
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
        deferWebhook: (deliver) => {
          deliverWebhook = deliver;
        },
        ...origin,
      });
    });

    return outcome;
  } finally {
    // Outside the lock, deliberately: inside it, a webhook target that takes 30s to answer made every
    // other run on this thread wait 30s behind it, and held the finished run's full graph state alive
    // for the duration.
    //
    // In the `finally` rather than after the `await` above, because the engine hands the delivery over
    // from its *own* `finally` — which runs even when the run is failing. A store write in the failure
    // path (the terminal status, the thread mirror) can itself reject, and then a delivery placed on
    // the success path would be silently dropped: the client sees a terminal `error` run and the
    // receiver watching for failures never hears about it. That is the case the webhook matters most.
    //
    // Still awaited, so a shutdown drain cannot exit mid-delivery; failures are logged by the engine
    // and never propagate.
    if (deliverWebhook) await deliverWebhook();
    control.clear(runId);
    runBaseCheckpoints.delete(runId);
  }
}
