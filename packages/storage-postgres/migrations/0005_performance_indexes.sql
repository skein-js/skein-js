-- Up Migration
-- skein:concurrent
--
-- Indexes for the list/search paths. Until now the schema had exactly three indexes
-- (runs_thread_id_idx, store_items_expires_at_idx, assistant_versions_assistant_id_idx), so every
-- `POST /threads/search` was a sequential scan plus a sort, and every `metadata @> …` filter — the
-- shape the auth ownership check uses on every request — was a sequential scan against jsonb.
--
-- `skein:concurrent` (read by scripts/generate-migrations.mjs) runs each statement outside a
-- transaction, one at a time. CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and a
-- plain CREATE INDEX would hold a write-blocking lock for the whole build — on a large existing
-- `threads` table that is a multi-minute stall at boot, during a rolling deploy, which is exactly
-- when it must not happen.
--
-- Every statement is IF NOT EXISTS so a partially-applied run can be retried: the ledger row is only
-- written once all of them succeed. One Postgres wart to know about — a CONCURRENTLY build that
-- fails leaves an *invalid* index behind, and IF NOT EXISTS will then skip it forever. See
-- docs/storage.md for how to spot and drop one.

-- The default thread sort. Composite because the query always orders by `<sortBy>, thread_id` — the
-- tiebreaker that makes OFFSET paging stable — so a lone created_at index would still sort.
CREATE INDEX CONCURRENTLY IF NOT EXISTS threads_created_at_thread_id_idx
  ON threads (created_at, thread_id);

-- `sortBy: "updated_at"`, the other sort the search surface accepts.
CREATE INDEX CONCURRENTLY IF NOT EXISTS threads_updated_at_thread_id_idx
  ON threads (updated_at, thread_id);

-- `WHERE status = $n ORDER BY created_at`. Status leads so the equality filter can use the index and
-- still get ordered rows out of it; status alone has too few distinct values to be worth indexing.
CREATE INDEX CONCURRENTLY IF NOT EXISTS threads_status_created_at_idx
  ON threads (status, created_at);

-- `metadata @> $n::jsonb`. GIN with jsonb_path_ops rather than the default: containment is the only
-- operator skein uses on this column, and path_ops is smaller and faster for it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS threads_metadata_idx
  ON threads USING gin (metadata jsonb_path_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS assistants_metadata_idx
  ON assistants USING gin (metadata jsonb_path_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS assistants_created_at_assistant_id_idx
  ON assistants (created_at, assistant_id);

-- `WHERE thread_id = $1 ORDER BY created_at`, used by listByThread and listActiveRuns — both on the
-- run-creation path, so this one is hot.
CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_thread_id_created_at_idx
  ON runs (thread_id, created_at);

-- Superseded by the composite above, whose leading column is the same. Kept until now only because
-- nothing else needed changing here; a redundant index costs write amplification on every run.
DROP INDEX CONCURRENTLY IF EXISTS runs_thread_id_idx;

-- The store search's default ordering.
CREATE INDEX CONCURRENTLY IF NOT EXISTS store_items_created_at_key_idx
  ON store_items (created_at, key);

-- Down Migration

DROP INDEX IF EXISTS store_items_created_at_key_idx;
DROP INDEX IF EXISTS runs_thread_id_created_at_idx;
DROP INDEX IF EXISTS assistants_created_at_assistant_id_idx;
DROP INDEX IF EXISTS assistants_metadata_idx;
DROP INDEX IF EXISTS threads_metadata_idx;
DROP INDEX IF EXISTS threads_status_created_at_idx;
DROP INDEX IF EXISTS threads_updated_at_thread_id_idx;
DROP INDEX IF EXISTS threads_created_at_thread_id_idx;
CREATE INDEX runs_thread_id_idx ON runs (thread_id);
