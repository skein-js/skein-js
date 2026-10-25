import { runError } from "@skein-js/core";

import type { ProtocolContext } from "../context.js";
import { createProtocolServiceFromContext } from "../service.js";

import { markRecoveringCancellation, readNativeOrigin } from "./native-origin.js";
import { scheduleNativeOutcome, settleNativeRun } from "./native-outcome.js";

/** Only drains explicitly owned native intents; it never adopts inline or ordinary pending runs. */
export function createNativeRecovery(context: ProtocolContext) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let stopped = true;
  const tick = async () => {
    const admission = context.deps.store.admission;
    if (!admission || stopped) return;
    const now = context.deps.clock();
    const claims = await admission.claimDispatches({
      now: now.toISOString(),
      leaseUntil: new Date(now.getTime() + 30_000).toISOString(),
      limit: 100,
    });
    for (const claim of claims) {
      if (stopped) break;
      try {
        const run = await context.deps.store.runs.get(claim.runId);
        if (!run) continue;
        if (claim.kind === "cancel") {
          context.control.abort(
            run.run_id,
            run.status === "interrupted"
              ? "interrupt"
              : claim.action === "rollback"
                ? "rollback"
                : "cancel",
          );
          await context.deps.bus.close(run.run_id);
          if (run.status === "cancelled")
            await createProtocolServiceFromContext(context).runs.cancel(
              run.run_id,
              markRecoveringCancellation({ action: claim.action, wait: false }),
            );
          const origin = readNativeOrigin(await context.deps.store.runs.getKwargs(run.run_id));
          if (origin?.outcomeTarget)
            await scheduleNativeOutcome(
              context.deps,
              (await context.deps.store.deliveries?.get(origin.deliveryId)) ?? undefined,
            );
        } else {
          const origin = readNativeOrigin(await context.deps.store.runs.getKwargs(run.run_id));
          if (
            origin?.deadlineAt &&
            Date.parse(origin.deadlineAt) <= context.deps.clock().getTime()
          ) {
            await settleNativeRun(context.deps, run, {
              status: "timeout",
              error: runError("RunTimeoutError", "Execution deadline expired before dispatch."),
            });
            context.control.abort(run.run_id, "timeout");
          } else
            await context.deps.queue.enqueue(
              { run_id: run.run_id, thread_id: run.thread_id },
              {
                delayMs: Math.max(0, Date.parse(claim.notBefore) - context.deps.clock().getTime()),
              },
            );
        }
        await admission.markDispatched(claim.runId, claim.token);
      } catch (error) {
        context.deps.logger.warn(
          `native dispatch ${claim.runId}: recoverable dispatch failure`,
          error,
        );
      }
    }
  };
  const schedule = () => {
    if (active || stopped) return;
    active = tick()
      .catch((error: unknown) =>
        context.deps.logger.warn("Native admission recovery failed", error),
      )
      .finally(() => {
        active = undefined;
      });
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule();
      timer = setInterval(schedule, 1000);
      timer.unref();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await active;
    },
  };
}
