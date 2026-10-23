import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { openSqliteStorage } from "@skein-js/storage-sqlite";
import { expect, it } from "vitest";

import { inspectSqliteThreadStorage } from "./thread-storage.js";

it("reports actual SQLite checkpoint and pending-write blob lengths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skein-storage-"));
  const storage = await openSqliteStorage({ filename: join(directory, "state.sqlite") });
  try {
    const saver = new SqliteSaver(storage.database);
    const checkpoint = {
      v: 4,
      id: "checkpoint",
      ts: new Date().toISOString(),
      channel_values: { value: "hello" },
      channel_versions: { value: 1 },
      versions_seen: {},
    };
    const config = await saver.put(
      { configurable: { thread_id: "thread", checkpoint_ns: "" } },
      checkpoint,
      { source: "loop", step: 1, parents: {} },
    );
    await saver.putWrites(config, [["value", "pending"]], "task");
    const result = inspectSqliteThreadStorage(storage.database, "thread");
    const expected = storage.database
      .prepare(
        "SELECT length(checkpoint)+length(metadata) AS bytes FROM checkpoints WHERE thread_id=?",
      )
      .get("thread") as { bytes: number };
    expect(result.checkpoints).toEqual({ count: 1, bytes: expected.bytes });
    expect(result.pending_writes.count).toBe(1);
    expect(result.total_bytes).toBe(result.checkpoints.bytes + result.pending_writes.bytes);
    await saver.deleteThread("thread");
    expect(inspectSqliteThreadStorage(storage.database, "thread").total_bytes).toBe(0);
  } finally {
    await storage.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
