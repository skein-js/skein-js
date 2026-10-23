import type { MemorySaver } from "@langchain/langgraph";
import type { ThreadStorage } from "@skein-js/core";

/** Count the saver's existing encoded buffers; channel values are inline in checkpoint payloads. */
export function inspectMemoryThreadStorage(
  saver: Pick<MemorySaver, "storage" | "writes">,
  threadId: string,
): ThreadStorage {
  const checkpoints = { count: 0, bytes: 0 };
  const pending_writes = { count: 0, bytes: 0 };
  for (const namespace of Object.values(saver.storage[threadId] ?? {}))
    for (const [checkpoint, metadata] of Object.values(namespace)) {
      checkpoints.count++;
      checkpoints.bytes += checkpoint.byteLength + metadata.byteLength;
    }
  for (const [coordinate, writes] of Object.entries(saver.writes)) {
    const [owner] = JSON.parse(coordinate) as string[];
    if (owner !== threadId) continue;
    for (const [, , value] of Object.values(writes)) {
      pending_writes.count++;
      pending_writes.bytes += value.byteLength;
    }
  }
  return {
    thread_id: threadId,
    total_bytes: checkpoints.bytes + pending_writes.bytes,
    checkpoints,
    channel_values: { count: 0, bytes: 0, by_channel: {} },
    pending_writes,
  };
}
