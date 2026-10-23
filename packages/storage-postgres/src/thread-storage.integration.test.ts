import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { startPostgres } from "@skein-js/test-support";
import { Pool } from "pg";
import { expect, it } from "vitest";

import { inspectPostgresThreadStorage } from "./thread-storage.js";

it("accounts for stored JSONB, versioned channel blobs and pending writes in one saver", async () => {
  const postgres = await startPostgres();
  const pool = new Pool({ connectionString: postgres.url });
  try {
    const saver = new PostgresSaver(pool);
    await saver.setup();
    const checkpoint = {
      v: 4,
      id: "checkpoint",
      ts: new Date().toISOString(),
      channel_values: { value: "stored".repeat(10_000) },
      channel_versions: { value: 1 },
      versions_seen: {},
    };
    const config = await saver.put(
      { configurable: { thread_id: "thread", checkpoint_ns: "" } },
      checkpoint,
      { source: "loop", step: 1, parents: {} },
      { value: 1 },
    );
    await saver.putWrites(config, [["value", "pending".repeat(10_000)]], "task");
    const sizes = await inspectPostgresThreadStorage(pool, "thread");
    const { rows } = await pool.query<{ bytes: number }>(
      "SELECT (pg_column_size(checkpoint)+pg_column_size(metadata))::float8 AS bytes FROM checkpoints WHERE thread_id=$1",
      ["thread"],
    );
    expect(sizes.checkpoints).toEqual({ count: 1, bytes: rows[0]!.bytes });
    const blobs = await pool.query<{ stored: number; logical: number }>(
      "SELECT pg_column_size(blob)::float8 AS stored, octet_length(blob)::float8 AS logical FROM checkpoint_blobs WHERE thread_id=$1",
      ["thread"],
    );
    const writes = await pool.query<{ stored: number; logical: number }>(
      "SELECT pg_column_size(blob)::float8 AS stored, octet_length(blob)::float8 AS logical FROM checkpoint_writes WHERE thread_id=$1",
      ["thread"],
    );
    expect(sizes.channel_values.bytes).toBe(blobs.rows[0]!.stored);
    expect(sizes.pending_writes.bytes).toBe(writes.rows[0]!.stored);
    expect(blobs.rows[0]!.stored).toBeLessThan(blobs.rows[0]!.logical);
    expect(writes.rows[0]!.stored).toBeLessThan(writes.rows[0]!.logical);
    expect(sizes.channel_values.count).toBe(1);
    expect(sizes.channel_values.by_channel["value"]?.versions).toBe(1);
    expect(sizes.pending_writes.count).toBe(1);
    expect(sizes.total_bytes).toBe(
      sizes.checkpoints.bytes + sizes.channel_values.bytes + sizes.pending_writes.bytes,
    );
    await saver.deleteThread("thread");
    expect((await inspectPostgresThreadStorage(pool, "thread")).total_bytes).toBe(0);
  } finally {
    await pool.end();
    await postgres.stop();
  }
}, 60_000);
