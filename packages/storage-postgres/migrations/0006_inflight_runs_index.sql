-- Up Migration
-- skein:concurrent
--
-- `POST /runs/cancel` with only a status filter sweeps *every* thread's inflight runs
-- (`RunRepo.listActiveRuns()` with no thread id). Without an index that is a sequential scan over
-- the whole `runs` table plus a sort, on a table that only ever grows — and `runs` is the largest
-- table skein writes, one row per turn forever.
--
-- A **partial** index rather than one on `status`: inflight is a vanishingly small slice of a mature
-- `runs` table (every run ends terminal), so the index stays tiny and its maintenance cost is two
-- entries per run's lifetime — one on insert, one when it settles out of the predicate. An index on
-- all of `status` would carry every historical row to serve a query that never wants one.
--
-- The predicate is spelled out rather than derived from TERMINAL_RUN_STATUSES: Postgres needs a
-- literal, immutable predicate to match a query against it. It must stay in step with the
-- `NOT (status = ANY(...))` filter in `listActiveRuns` — the planner silently falls back to a seq
-- scan if the two ever disagree, so this is a performance coupling, not a correctness one.
--
-- `skein:concurrent` for the same reason as 0005: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction, and a plain build would hold a write-blocking lock on `runs` at boot.

CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_inflight_created_at_idx
  ON runs (created_at, run_id)
  WHERE status IN ('pending', 'running');

-- Down Migration

DROP INDEX IF EXISTS runs_inflight_created_at_idx;
