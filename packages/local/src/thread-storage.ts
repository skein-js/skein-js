import type { ThreadStorage } from "@skein-js/core";
import type { Database } from "better-sqlite3";

/** SQLiteSaver stores channel values inline; length(BLOB) is the exact stored serialized length. */
export function inspectSqliteThreadStorage(database: Database, threadId: string): ThreadStorage {
  const count = (table: "checkpoints" | "writes", expression: string) =>
    database
      .prepare(
        `SELECT count(*) AS count, coalesce(sum(${expression}),0) AS bytes FROM ${table} WHERE thread_id=?`,
      )
      .get(threadId) as { count: number; bytes: number };
  const checkpoints = count(
    "checkpoints",
    "coalesce(length(checkpoint),0)+coalesce(length(metadata),0)",
  );
  const pending_writes = count("writes", "coalesce(length(value),0)");
  return {
    thread_id: threadId,
    total_bytes: checkpoints.bytes + pending_writes.bytes,
    checkpoints,
    channel_values: { count: 0, bytes: 0, by_channel: {} },
    pending_writes,
  };
}
