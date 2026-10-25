// Direct manipulation of a thread's LangGraph checkpoint history — the two operations skein performs
// on the checkpointer beyond a normal run: copying a thread's history to a new id (`POST
// /threads/{id}/copy`), and rolling a thread back to an earlier checkpoint (`multitask_strategy:
// "rollback"`). Both keep to the `BaseCheckpointSaver` surface (`list`/`put`/`putWrites`/
// `deleteThread`), preserving each checkpoint namespace.

import { randomUUID } from "node:crypto";

import type { ThreadCheckpointer, ThreadCheckpointTuple } from "../graphs/thread-checkpointer.js";

/**
 * Clone a checkpoint before re-putting it under another thread id.
 *
 * Injected (`ProtocolDeps.cloneCheckpoint`) rather than imported: LangGraph's `copyCheckpoint` is a
 * *value* import, and it was the last one keeping a graph runtime in this package's install. The
 * fallback is identity — correct whenever a checkpointer's `put` does not retain the object it is
 * given, and the only behaviour available to a runtime that ships no cloner.
 */
export type CloneCheckpoint = (checkpoint: unknown) => unknown;

const passThrough: CloneCheckpoint = (checkpoint) => checkpoint;

function checkpointNamespace(tuple: ThreadCheckpointTuple): string {
  return String(tuple.config.configurable?.["checkpoint_ns"] ?? "");
}

/** Retain explicit cross-namespace pointers, including pointers carried by pending task writes. */
function referencedCheckpoints(
  tuples: ThreadCheckpointTuple[],
  seeds: ThreadCheckpointTuple[],
): ThreadCheckpointTuple[] {
  const byCoordinate = new Map(
    tuples.map((tuple) => [`${checkpointNamespace(tuple)}\0${tuple.checkpoint.id}`, tuple]),
  );
  const kept = new Set(seeds);
  const visited = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || visited.has(value)) return;
    visited.add(value);
    const record = value as Record<string, unknown>;
    const add = (namespace: string, id: string) => {
      const tuple = byCoordinate.get(`${namespace}\0${id}`);
      if (tuple && !kept.has(tuple)) {
        kept.add(tuple);
        visit(tuple);
      }
    };
    if (typeof record["checkpoint_id"] === "string")
      add(String(record["checkpoint_ns"] ?? ""), record["checkpoint_id"]);
    for (const field of ["checkpoint_map", "parents"]) {
      const coordinates = record[field];
      if (coordinates && typeof coordinates === "object") {
        for (const [namespace, id] of Object.entries(coordinates))
          if (typeof id === "string") add(namespace, id);
      }
    }
    // Delta channels reconstruct values from ancestor writes until their next full snapshot.
    // These are dependencies of the current state, just like explicit child coordinates.
    const counters = (record["metadata"] as Record<string, unknown> | undefined)?.[
      "counters_since_delta_snapshot"
    ];
    if (counters && typeof counters === "object" && Object.keys(counters).length)
      visit(record["parentConfig"]);
    for (const [key, child] of Object.entries(record)) if (key !== "parentConfig") visit(child);
  };
  for (const tuple of seeds) visit(tuple);
  return tuples.filter((tuple) => kept.has(tuple));
}

/**
 * Write `tuples` (oldest-first) under `targetId`. Each checkpoint is re-put with its parent link, and
 * its pending writes are re-applied grouped by task — the same shape LangGraph persisted them in.
 */
async function replayCheckpoints(
  checkpointer: ThreadCheckpointer,
  targetId: string,
  tuples: ThreadCheckpointTuple[],
  cloneCheckpoint: CloneCheckpoint,
): Promise<void> {
  for (const tuple of tuples) {
    const ns = (tuple.config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const parentId = tuple.parentConfig?.configurable?.checkpoint_id as string | undefined;
    const putConfig = {
      configurable: { thread_id: targetId, checkpoint_ns: ns, checkpoint_id: parentId },
    };
    await checkpointer.put(
      putConfig,
      cloneCheckpoint(tuple.checkpoint) as typeof tuple.checkpoint,
      tuple.metadata ?? {},
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
  checkpointer: ThreadCheckpointer,
  threadId: string,
  limit?: number,
): Promise<ThreadCheckpointTuple[]> {
  const tuples: ThreadCheckpointTuple[] = [];
  for await (const tuple of checkpointer.list(
    { configurable: { thread_id: threadId } },
    limit === undefined ? undefined : { limit },
  )) {
    tuples.push(tuple);
    if (limit !== undefined && tuples.length >= limit) break;
  }
  return tuples;
}

/** Preserve a recoverable copy without using a predictable, potentially real thread ID. */
async function replaceCheckpointHistory(
  checkpointer: ThreadCheckpointer,
  threadId: string,
  operation: "prune" | "rollback",
  tuples: ThreadCheckpointTuple[],
  cloneCheckpoint: CloneCheckpoint,
): Promise<void> {
  let scratchThreadId: string;
  do {
    scratchThreadId = `${threadId}::skein-${operation}:${randomUUID()}`;
  } while ((await listCheckpoints(checkpointer, scratchThreadId, 1)).length > 0);

  // Save before erasure, and retain this copy if replacing the original fails.
  await replayCheckpoints(checkpointer, scratchThreadId, tuples, cloneCheckpoint);
  try {
    await checkpointer.deleteThread(threadId);
    await replayCheckpoints(checkpointer, threadId, tuples, cloneCheckpoint);
  } catch (error) {
    throw new Error(
      `${operation === "prune" ? "pruning" : "rolling back"} thread "${threadId}" failed; ` +
        `its checkpoint backup survives under "${scratchThreadId}"`,
      { cause: error },
    );
  }
  // A cleanup failure must not turn a successful replacement into an apparent failed operation.
  await checkpointer.deleteThread(scratchThreadId).catch(() => undefined);
}

/**
 * Replay every checkpoint of `sourceId` under `targetId` so a copied thread carries the same graph
 * history. Checkpoints are keyed only by `thread_id`, so the source id is simply swapped. Oldest-first
 * so each checkpoint's parent already exists when it lands.
 */
export async function copyCheckpointHistory(
  checkpointer: ThreadCheckpointer,
  sourceId: string,
  targetId: string,
  cloneCheckpoint: CloneCheckpoint = passThrough,
): Promise<void> {
  const tuples = await listCheckpoints(checkpointer, sourceId);
  await replayCheckpoints(checkpointer, targetId, tuples.reverse(), cloneCheckpoint);
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
  checkpointer: ThreadCheckpointer,
  threadId: string,
  cloneCheckpoint: CloneCheckpoint = passThrough,
): Promise<boolean> {
  // Cross-namespace references can name older child tips; inspect their coordinates before pruning.
  const tuples = await listCheckpoints(checkpointer, threadId);
  const latestByNamespace = new Map<string, ThreadCheckpointTuple>();
  for (const tuple of tuples) {
    const namespace = checkpointNamespace(tuple);
    if (!latestByNamespace.has(namespace)) latestByNamespace.set(namespace, tuple);
  }
  const keep = referencedCheckpoints(tuples, [...latestByNamespace.values()]);
  if (keep.length === tuples.length) return false;

  // Dropping `parentConfig` is what re-roots the keeper: `replayCheckpoints` derives the parent link
  // from it, so an absent one produces the same root `put` it already uses for the oldest tuple in a
  // chain — and its pending-writes handling comes along for free.
  const coordinates = new Set(
    keep.map((tuple) => `${checkpointNamespace(tuple)}\0${tuple.checkpoint.id}`),
  );
  const rootedKeep = keep
    .map((tuple) => {
      const parent = tuple.parentConfig?.configurable;
      if (
        parent &&
        coordinates.has(
          `${String(parent["checkpoint_ns"] ?? "")}\0${String(parent["checkpoint_id"])}`,
        )
      )
        return tuple;
      const { parentConfig: _removedAncestor, ...rooted } = tuple;
      return rooted;
    })
    .reverse();

  await replaceCheckpointHistory(checkpointer, threadId, "prune", rootedKeep, cloneCheckpoint);
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
  checkpointer: ThreadCheckpointer,
  threadId: string,
  baseCheckpointId: string | undefined,
  cloneCheckpoint: CloneCheckpoint = passThrough,
): Promise<void> {
  if (baseCheckpointId === undefined) {
    await checkpointer.deleteThread(threadId);
    return;
  }

  const tuples = await listCheckpoints(checkpointer, threadId);
  const byId = new Map(
    tuples
      .filter((tuple) => checkpointNamespace(tuple) === "")
      .map((tuple) => [tuple.checkpoint.id, tuple]),
  );
  if (!byId.has(baseCheckpointId)) return; // base already gone — don't touch valid history

  // Walk parent links from the base to the root: the checkpoints that predate the displaced run.
  const keep: ThreadCheckpointTuple[] = [];
  let cursor: string | undefined = baseCheckpointId;
  const seen = new Set<string>();
  while (cursor !== undefined && byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    const tuple = byId.get(cursor)!;
    keep.push(tuple);
    cursor = tuple.parentConfig?.configurable?.checkpoint_id as string | undefined;
  }

  // Child snapshots can be newer than the root that scheduled them. Explicit pointers retain those;
  // otherwise only child history preceding the rollback tip survives.
  const base = byId.get(baseCheckpointId)!;
  const timestamp = (base.checkpoint as unknown as { ts?: string }).ts;
  for (const tuple of tuples) {
    const childTimestamp = (tuple.checkpoint as unknown as { ts?: string }).ts;
    if (checkpointNamespace(tuple) && timestamp && childTimestamp && childTimestamp <= timestamp)
      keep.push(tuple);
  }
  const retained = referencedCheckpoints(tuples, keep).reverse();
  await replaceCheckpointHistory(checkpointer, threadId, "rollback", retained, cloneCheckpoint);
}
