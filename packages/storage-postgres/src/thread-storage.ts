import type { ThreadStorage } from "@skein-js/core";
import type { Pool } from "pg";

/** One MVCC snapshot: Stored JSONB and BYTEA datum sizes, never serialized estimates. */
export async function inspectPostgresThreadStorage(
  pool: Pool,
  threadId: string,
): Promise<ThreadStorage> {
  const { rows } = await pool.query<ThreadStorage>(
    `WITH checkpoint_totals AS (
    SELECT count(*)::float8 AS count, coalesce(sum(coalesce(pg_column_size(checkpoint),0)+coalesce(pg_column_size(metadata),0)),0)::float8 AS bytes FROM checkpoints WHERE thread_id=$1
  ), channel_totals AS (
    SELECT channel, count(*)::float8 AS versions, coalesce(sum(pg_column_size(blob)),0)::float8 AS bytes FROM checkpoint_blobs WHERE thread_id=$1 GROUP BY channel
  ), write_totals AS (
    SELECT count(*)::float8 AS count, coalesce(sum(pg_column_size(blob)),0)::float8 AS bytes FROM checkpoint_writes WHERE thread_id=$1
  ), channel_summary AS (
    SELECT coalesce(sum(versions),0)::float8 AS count, coalesce(sum(bytes),0)::float8 AS bytes,
      coalesce(jsonb_object_agg(channel,jsonb_build_object('versions',versions,'bytes',bytes)),'{}'::jsonb) AS by_channel FROM channel_totals
  ) SELECT $1::text AS thread_id, (c.bytes+b.bytes+w.bytes) AS total_bytes,
    jsonb_build_object('count',c.count,'bytes',c.bytes) AS checkpoints,
    jsonb_build_object('count',b.count,'bytes',b.bytes,'by_channel',b.by_channel) AS channel_values,
    jsonb_build_object('count',w.count,'bytes',w.bytes) AS pending_writes
  FROM checkpoint_totals c CROSS JOIN channel_summary b CROSS JOIN write_totals w`,
    [threadId],
  );
  return rows[0]!;
}
