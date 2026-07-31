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

/**
 * Read a thread's checkpoint tuples, newest-first. `limit` bounds the read at the saver — which is where
 * it has to be: `PostgresSaver.list` only emits a SQL `LIMIT` when given one, and otherwise materializes
 * every checkpoint row (channel values included) before yielding the first tuple, so breaking out of the
 * loop afterwards saves nothing.
 */
async function listCheckpoints(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
  limit?: number,
): Promise<CheckpointTuple[]> {
  const tuples: CheckpointTuple[] = [];
  for await (const tuple of checkpointer.list(
    { configurable: { thread_id: threadId } },
    limit === undefined ? undefined : { limit },
  )) {
    tuples.push(tuple);
    if (limit !== undefined && tuples.length >= limit) break;
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
 * Drop every checkpoint of a thread except its newest — `POST /threads/prune` with
 * `strategy: "keep_latest"`. The thread and its current state survive; the history behind them does not.
 *
 * Same shape as {@link rollbackThreadCheckpointsTo}, because the saver interface offers no per-checkpoint
 * delete: read, `deleteThread`, replay the keeper. The difference is the keeper's **parent link is
 * cleared** — its ancestors are precisely what this is removing, so replaying it with the original link
 * would leave the thread's tip pointing at a checkpoint that no longer exists, and `getState`'s
 * `parent_checkpoint` would name a dead id.
 *
 * Returns whether anything was pruned, so a caller can count only the threads it actually changed. A
 * thread with 0 or 1 checkpoints is left completely untouched — there is nothing to remove, and doing
 * the delete-and-replay anyway would risk its only checkpoint for no gain.
 */
export async function pruneThreadCheckpointsToLatest(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
): Promise<boolean> {
  // Two tuples, not the whole history: all this needs is the keeper plus the answer to "is there more
  // than one?". Draining the history would re-introduce the unbounded read `rollbackThreadCheckpointsTo`
  // documents as a statement-timeout hazard — on the very operation a user reaches for *because* a thread
  // got large.
  const tuples = await listCheckpoints(checkpointer, threadId, 2);
  if (tuples.length <= 1) return false;

  // Dropping `parentConfig` is what re-roots the keeper: `replayCheckpoints` derives the parent link
  // from it, so an absent one produces the same root `put` it already uses for the oldest tuple in a
  // chain — and its pending-writes handling comes along for free.
  const { parentConfig: _removedAncestor, ...rootedLatest } = tuples[0]!; // newest-first; length > 1

  // Written under a scratch thread id *before* the delete, so the keeper exists in two places for the
  // duration of the destructive step. Without it, a `put` that fails after `deleteThread` — a statement
  // timeout, a pool exhaustion, a serialization error on a large checkpoint — leaves the thread with
  // **zero** checkpoints: its current state gone, not just its history, on a bulk endpoint that can be
  // pointed at a thousand threads. The insurance copy is removed on the way out.
  const scratchThreadId = `${threadId}::skein-prune`;
  await replayCheckpoints(checkpointer, scratchThreadId, [rootedLatest]);
  try {
    await checkpointer.deleteThread(threadId);
    await replayCheckpoints(checkpointer, threadId, [rootedLatest]);
  } catch (error) {
    // The scratch copy is deliberately left behind here: it is the only remaining copy of the state, and
    // the id is derived from the thread's own so an operator can find it. Recover with
    // `copyCheckpointHistory(checkpointer, "<thread>::skein-prune", "<thread>")`.
    throw new Error(
      `pruning thread "${threadId}" failed after its checkpoints were deleted; the kept checkpoint ` +
        `survives under "${scratchThreadId}"`,
      { cause: error },
    );
  }
  // Best-effort: the prune has already succeeded, so a leftover scratch thread is clutter rather than a
  // failure — and reporting it as one would make a successful prune look broken.
  await checkpointer.deleteThread(scratchThreadId).catch(() => undefined);
  return true;
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
