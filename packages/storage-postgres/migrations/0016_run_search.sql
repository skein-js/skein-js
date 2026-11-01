-- Up Migration
-- skein:concurrent
-- Historical search cannot use the existing inflight-only index. Keep that small queue index;
-- these cover global paging, status/assistant selection, time windows, and ownership containment.
-- Do not duplicate variable-length run IDs in these btrees: IDs that fit the existing primary key
-- can exceed the tuple limit when combined with other columns. The query sorts equal timestamps
-- by run_id after using the creation-time prefix. Hash equality indexes accept long assistant IDs
-- without combining them with a run ID or adding a new identifier-length restriction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_search_created_at_idx
  ON runs (created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_search_status_created_at_idx
  ON runs (status, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_search_assistant_idx
  ON runs USING hash (assistant_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_search_updated_at_idx ON runs (updated_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_search_metadata_idx
  ON runs USING gin (metadata jsonb_path_ops);

-- Down Migration
DROP INDEX IF EXISTS runs_search_metadata_idx;
DROP INDEX IF EXISTS runs_search_updated_at_idx;
DROP INDEX IF EXISTS runs_search_assistant_idx;
DROP INDEX IF EXISTS runs_search_status_created_at_idx;
DROP INDEX IF EXISTS runs_search_created_at_idx;
