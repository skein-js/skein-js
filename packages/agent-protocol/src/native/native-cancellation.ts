import { isTerminalRunStatus } from "@skein-js/core";

import type { ResolvedDeps } from "../deps.js";
import type { RunControl } from "../runs/cancellation.js";

/** Pub/sub is a promptness hint; the durable terminal row is the cancellation authority. */
export function observeDurableCancellation(deps: ResolvedDeps, runId: string, control: RunControl) {
  let stopped = false;
  let active: Promise<void> | undefined;
  const observe = async () => {
    const run = await deps.store.runs.get(runId);
    if (stopped || control.signal.aborted) return;
    if (!run || isTerminalRunStatus(run.status))
      control.abort(
        run?.status === "timeout"
          ? "timeout"
          : run?.status === "interrupted"
            ? "interrupt"
            : "cancel",
      );
  };
  const timer = setInterval(() => {
    if (active || stopped || control.signal.aborted) return;
    active = observe()
      .catch((error: unknown) =>
        deps.logger.warn(`run ${runId}: durable cancellation observation failed`, error),
      )
      .finally(() => {
        active = undefined;
      });
  }, 1000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}
