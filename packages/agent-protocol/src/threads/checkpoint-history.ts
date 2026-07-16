// Direct manipulation of a thread's LangGraph checkpoint history — the two operations skein performs
// on the checkpointer beyond a normal run: copying a thread's history to a new id (`POST
// /threads/{id}/copy`), and rolling a thread back to an earlier checkpoint (`multitask_strategy:
// "rollback"`). Both keep to the `BaseCheckpointSaver` surface (`list`/`put`/`putWrites`/
// `deleteThread`); skein keys checkpoints by `thread_id` only (namespace `""`).

import {
  copyCheckpoint,
  type BaseCheckpointSaver,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph";

/**
 * Write `tuples` (oldest-first) under `targetId`. Each checkpoint is re-put with its parent link, and
 * its pending writes are re-applied grouped by task — the same shape LangGraph persisted them in.
 */
async function replayCheckpoints(
  checkpointer: BaseCheckpointSaver,
  targetId: string,
  tuples: CheckpointTuple[],
): Promise<void> {
  for (const tuple of tuples) {
    const ns = (tuple.config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const parentId = tuple.parentConfig?.configurable?.checkpoint_id as string | undefined;
    const putConfig = {
      configurable: { thread_id: targetId, checkpoint_ns: ns, checkpoint_id: parentId },
    };
    await checkpointer.put(
      putConfig,
      copyCheckpoint(tuple.checkpoint),
      tuple.metadata ?? ({} as CheckpointMetadata),
      tuple.checkpoint.channel_versions,
    );
    if (tuple.pendingWrites && tuple.pendingWrites.length > 0) {
      const writeConfig = {
        configurable: {
          thread_id: targetId,
          checkpoint_ns: ns,
          checkpoint_id: tuple.checkpoint.id,
        },
      };
      // pendingWrites are [taskId, channel, value]; putWrites takes [channel, value] per taskId.
      const byTask = new Map<string, [string, unknown][]>();
      for (const [taskId, channel, value] of tuple.pendingWrites) {
        const writes = byTask.get(taskId) ?? [];
        writes.push([channel, value]);
        byTask.set(taskId, writes);
      }
      for (const [taskId, writes] of byTask) {
        await checkpointer.putWrites(writeConfig, writes, taskId);
      }
    }
  }
}

/** Read all of a thread's checkpoint tuples (the saver yields newest-first). */
async function listCheckpoints(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
): Promise<CheckpointTuple[]> {
  const tuples: CheckpointTuple[] = [];
  for await (const tuple of checkpointer.list({ configurable: { thread_id: threadId } })) {
    tuples.push(tuple);
  }
  return tuples;
}

/**
 * Replay every checkpoint of `sourceId` under `targetId` so a copied thread carries the same graph
 * history. Checkpoints are keyed only by `thread_id`, so the source id is simply swapped. Oldest-first
 * so each checkpoint's parent already exists when it lands.
 */
export async function copyCheckpointHistory(
  checkpointer: BaseCheckpointSaver,
  sourceId: string,
  targetId: string,
): Promise<void> {
  const tuples = await listCheckpoints(checkpointer, sourceId);
  await replayCheckpoints(checkpointer, targetId, tuples.reverse());
}

/**
 * Roll a thread's checkpoint history back to `baseCheckpointId` — the tip that existed before the
 * displaced run wrote anything — dropping every checkpoint the displaced run added. This is skein's
 * `rollback` multitask strategy: the standard `BaseCheckpointSaver` has no per-run delete, so we
 * keep the base's ancestor chain, wipe the thread (`deleteThread`), and replay only the keepers.
 *
 * `baseCheckpointId === undefined` means the thread had no checkpoints when the displaced run
 * started, so the rollback is a clean wipe. If the base id is no longer present (already rolled, or
 * pruned), we leave the history untouched rather than risk destroying valid state.
 */
export async function rollbackThreadCheckpointsTo(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
  baseCheckpointId: string | undefined,
): Promise<void> {
  if (baseCheckpointId === undefined) {
    await checkpointer.deleteThread(threadId);
    return;
  }

  const tuples = await listCheckpoints(checkpointer, threadId);
  const byId = new Map(tuples.map((tuple) => [tuple.checkpoint.id, tuple]));
  if (!byId.has(baseCheckpointId)) return; // base already gone — don't touch valid history

  // Walk parent links from the base to the root: the checkpoints that predate the displaced run.
  const keep: CheckpointTuple[] = [];
  let cursor: string | undefined = baseCheckpointId;
  const seen = new Set<string>();
  while (cursor !== undefined && byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    const tuple = byId.get(cursor)!;
    keep.push(tuple);
    cursor = tuple.parentConfig?.configurable?.checkpoint_id as string | undefined;
  }

  await checkpointer.deleteThread(threadId);
  await replayCheckpoints(checkpointer, threadId, keep.reverse());
}
