import { SkeinHttpError, type Checkpoint } from "@skein-js/core";

import type { ResolvedDeps } from "../deps.js";

/** Called with the thread execution lease held, both at admission and before invocation. */
export async function verifyResumeTarget(
  deps: ResolvedDeps,
  threadId: string,
  runId: string,
  target: {
    expectedRunId?: string;
    checkpoint?: Checkpoint;
    interruptIds?: readonly string[];
  },
): Promise<void> {
  if (!target.expectedRunId) return;
  const runs = (await deps.store.runs.listByThread(threadId))
    .filter((run) => run.run_id !== runId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.run_id.localeCompare(a.run_id));
  const checkpoint = target.checkpoint;
  const current = await deps.checkpointer.getTuple({
    configurable: { thread_id: threadId, checkpoint_ns: checkpoint?.checkpoint_ns ?? "" },
  });
  if (
    runs[0]?.run_id !== target.expectedRunId ||
    runs[0].status !== "interrupted" ||
    !checkpoint?.checkpoint_id ||
    current?.checkpoint.id !== checkpoint.checkpoint_id
  )
    throw SkeinHttpError.conflict("The resume target no longer owns the interrupted checkpoint.", {
      code: "stale_resume",
    });
  if (target.interruptIds?.length) {
    const thread = await deps.store.threads.get(threadId);
    const pending = Object.values(thread?.interrupts ?? {}).flat();
    if (target.interruptIds.some((id) => !pending.some((interrupt) => interrupt.id === id)))
      throw SkeinHttpError.conflict("The expected interrupt is no longer pending.", {
        code: "stale_resume",
      });
  }
}
