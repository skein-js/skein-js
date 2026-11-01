-- Up Migration
-- skein:concurrent
-- Historical search cannot use the existing inflight-only index. Keep that small queue index;
-- these cover global paging, status/assistant selection, time windows, and ownership containment.
CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_search_created_at_idx
  ON runs (created_at DESC, run_id COLLATE "C" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_search_status_created_at_idx
  ON runs (status, created_at DESC, run_id COLLATE "C" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_search_assistant_created_at_idx
  ON runs (assistant_id, created_at DESC, run_id COLLATE "C" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_search_updated_at_idx ON runs (updated_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_search_metadata_idx
  ON runs USING gin (metadata jsonb_path_ops);

-- Down Migration
DROP INDEX IF EXISTS runs_search_metadata_idx;
DROP INDEX IF EXISTS runs_search_updated_at_idx;
DROP INDEX IF EXISTS runs_search_assistant_created_at_idx;
DROP INDEX IF EXISTS runs_search_status_created_at_idx;
DROP INDEX IF EXISTS runs_search_created_at_idx;
