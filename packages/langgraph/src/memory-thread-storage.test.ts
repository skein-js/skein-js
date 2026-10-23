import { emptyCheckpoint, MemorySaver } from "@langchain/langgraph";
import { expect, it } from "vitest";

import { inspectMemoryThreadStorage } from "./memory-thread-storage.js";

it("counts the actual saver buffers across namespaces and excludes other threads", async () => {
  const saver = new MemorySaver();
  const metadata = { source: "loop" as const, step: 1, parents: {} };
  for (const [owner, namespace] of [
    ["thread", ""],
    ["thread", "child:task"],
    ["other", ""],
  ]) {
    const config = await saver.put(
      { configurable: { thread_id: owner, checkpoint_ns: namespace } },
      emptyCheckpoint(),
      metadata,
    );
    await saver.putWrites(config, [["value", "stored bytes"]], "task");
  }
  const result = inspectMemoryThreadStorage(saver, "thread");
  expect(result.checkpoints.count).toBe(2);
  expect(result.pending_writes.count).toBe(2);
  let expected = 0;
  for (const namespace of Object.values(saver.storage["thread"]!))
    for (const [checkpoint, metadata] of Object.values(namespace))
      expected += checkpoint.byteLength + metadata.byteLength;
  for (const [key, writes] of Object.entries(saver.writes))
    if ((JSON.parse(key) as string[])[0] === "thread")
      for (const [, , value] of Object.values(writes)) expected += value.byteLength;
  expect(result.total_bytes).toBe(expected);
  expect(result.channel_values).toEqual({ count: 0, bytes: 0, by_channel: {} });
  await saver.deleteThread("thread");
  expect(inspectMemoryThreadStorage(saver, "thread").total_bytes).toBe(0);
});
