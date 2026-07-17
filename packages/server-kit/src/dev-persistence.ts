// Snapshot/restore for the in-memory dev runtime, so `skein dev` can persist state to disk and
// survive a restart (mirroring how `langgraph dev` keeps local dev state). The protocol store
// snapshots itself; the LangGraph `MemorySaver` exposes public `storage`/`writes` maps whose values
// are `Uint8Array` blobs, so we base64-encode them to stay JSON-serializable. The combined
// `DevStateSnapshot` is what the CLI reads/writes as a single JSON file.

import type { MemorySaver } from "@langchain/langgraph";
import type { MemoryStoreSnapshot } from "@skein-js/storage-memory";

/** The checkpoint tuple `[checkpoint, metadata, parentId?]` with the blobs base64-encoded. */
type SerializedCheckpointTuple = [string, string, string | undefined];
/** `MemorySaver.storage` (thread → namespace → checkpointId → tuple) with blobs base64-encoded. */
type SerializedCheckpointStorage = Record<
  string,
  Record<string, Record<string, SerializedCheckpointTuple>>
>;
/** `MemorySaver.writes` (key → taskId+idx → `[taskId, channel, blob]`) with the blob base64-encoded. */
type SerializedCheckpointWrites = Record<string, Record<string, [string, string, string]>>;

export interface CheckpointerSnapshot {
  storage: SerializedCheckpointStorage;
  writes: SerializedCheckpointWrites;
}

/** A JSON-serializable snapshot of the whole in-memory dev runtime. */
export interface DevStateSnapshot {
  version: 1;
  store: MemoryStoreSnapshot;
  checkpoints: CheckpointerSnapshot;
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const fromBase64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));

/** Map every value of a `Record` through `fn`, preserving keys. */
const mapValues = <In, Out>(
  record: Record<string, In>,
  fn: (value: In) => Out,
): Record<string, Out> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fn(value)]));

export function snapshotCheckpointer(saver: MemorySaver): CheckpointerSnapshot {
  return {
    storage: mapValues(saver.storage, (namespaces) =>
      mapValues(namespaces, (checkpoints) =>
        mapValues(checkpoints, ([checkpoint, metadata, parentId]): SerializedCheckpointTuple => [
          toBase64(checkpoint),
          toBase64(metadata),
          parentId,
        ]),
      ),
    ),
    writes: mapValues(saver.writes, (taskWrites) =>
      mapValues(taskWrites, ([taskId, channel, blob]): [string, string, string] => [
        taskId,
        channel,
        toBase64(blob),
      ]),
    ),
  };
}

export function hydrateCheckpointer(saver: MemorySaver, snapshot: CheckpointerSnapshot): void {
  saver.storage = mapValues(snapshot.storage, (namespaces) =>
    mapValues(namespaces, (checkpoints) =>
      mapValues(
        checkpoints,
        ([checkpoint, metadata, parentId]): [Uint8Array, Uint8Array, string | undefined] => [
          fromBase64(checkpoint),
          fromBase64(metadata),
          parentId,
        ],
      ),
    ),
  );
  saver.writes = mapValues(snapshot.writes, (taskWrites) =>
    mapValues(taskWrites, ([taskId, channel, blob]): [string, string, Uint8Array] => [
      taskId,
      channel,
      fromBase64(blob),
    ]),
  );
}
