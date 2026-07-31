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
-- The predicate is a literal because Postgres needs one to match a query against it. The queries that
-- must match it (`listActiveRuns`, `hasActiveRun`, `createIfThreadIdle`) therefore filter *positively*
-- with `status IN ('pending','running')`, built from `INFLIGHT_RUN_STATUSES` — see INFLIGHT_STATUS_SQL.
--
-- A negated, parameterized filter (`NOT (status = ANY($1))`) does NOT match: proving it implies this
-- predicate would require enumerating the column's domain, which the planner does not do, and under a
-- generic plan the parameter is not even a constant. That form silently sequential-scans the whole table
-- while still paying this index's write cost — a performance coupling, not a correctness one, and the
-- reason the query and this predicate are both derived from one constant.
--
-- `skein:concurrent` for the same reason as 0005: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction, and a plain build would hold a write-blocking lock on `runs` at boot.

CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_inflight_created_at_idx
  ON runs (created_at, run_id)
  WHERE status IN ('pending', 'running');

-- Down Migration

DROP INDEX IF EXISTS runs_inflight_created_at_idx;
