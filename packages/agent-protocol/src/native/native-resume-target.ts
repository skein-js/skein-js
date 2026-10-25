import { SkeinHttpError } from "@skein-js/core";

import type { ResolvedDeps } from "../deps.js";
import { verifyResumeTarget } from "../runs/resume-target.js";

import type { NativeResumeTarget } from "./native-client.js";

/** Every supplied coordinate must still name this thread's current checkpoint in its namespace. */
export async function verifyNativeResumeTarget(
  deps: ResolvedDeps,
  threadId: string,
  runId: string,
  target: NativeResumeTarget,
  signal?: AbortSignal,
): Promise<void> {
  await verifyResumeTarget(deps, threadId, runId, {
    expectedRunId: target.runId,
    checkpoint: target.checkpoint,
    interruptIds: target.interruptIds,
  });
  signal?.throwIfAborted();
  for (const [namespace, checkpointId] of Object.entries(target.checkpoint.checkpoint_map ?? {})) {
    // Never pass the caller's ID or map to this read: it must resolve the authoritative tip.
    const current = await deps.checkpointer.getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: namespace },
    });
    signal?.throwIfAborted();
    if (!current || current.checkpoint.id !== checkpointId)
      throw SkeinHttpError.conflict("A mapped resume checkpoint is no longer current.", {
        code: "stale_resume",
      });
  }
}
