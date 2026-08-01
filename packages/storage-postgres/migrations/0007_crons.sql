-- Up Migration
--
-- Crons: schedules that fire runs on a cadence (LangGraph Platform's Crons resource).
--
-- The row is the source of truth for the whole wire contract — `search` filters and sorts it,
-- `count` counts it, `enabled` pauses it — and it is *also* the scheduler's coordination
-- mechanism. Both roles are why the schedule lives here rather than in the run queue: a queue can
-- hold a timer, but it cannot serve `sort_by=next_run_date` with a metadata filter and an offset.

CREATE TABLE crons (
  cron_id          text        PRIMARY KEY,
  assistant_id     text        NOT NULL,
  -- NULL means a *stateless* cron: every fire creates its own thread. A thread cron cannot outlive
  -- the thread it runs on, so the cascade makes "a cron whose thread is gone" unrepresentable
  -- rather than a case the scheduler has to handle on every occurrence (mirrors runs.thread_id).
  thread_id        text        REFERENCES threads (thread_id) ON DELETE CASCADE,
  schedule         text        NOT NULL,
  timezone         text,
  end_time         timestamptz,
  -- When this cron next fires. NULL means *dormant* — disabled, or no occurrence left before
  -- end_time — which is simultaneously the wire answer and what drops the row out of the partial
  -- index below. Deliberately has NO DEFAULT: it is only ever written from a value skein computed
  -- with a cron parser, never from the database clock.
  next_run_date    timestamptz,
  enabled          boolean     NOT NULL DEFAULT true,
  -- The compare-and-swap token the scheduler claims an occurrence with, bumped on EVERY write.
  --
  -- An integer rather than comparing `next_run_date` itself, and that is not a style choice: a
  -- timestamptz carries microseconds, which are truncated on the way back out through a
  -- millisecond `Date`, so a timestamp comparison could stop matching and no cron would ever fire
  -- again with nothing logged to say so. An integer also closes the ABA window where a PATCH
  -- recomputes back to the same instant between a scan and its claim.
  occurrence_seq   bigint      NOT NULL DEFAULT 0,
  on_run_completed text,
  payload          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  user_id          text,
  -- The principal a fired run executes as. Beside the row and never on the wire, for the same
  -- reason runs.kwargs is: `payload` is echoed to any reader of GET /runs/crons/{id}, and a
  -- caller's permission scopes are not a thing to echo.
  auth             jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- The scheduler's hot path, run once per tick per instance forever. Partial, because a dormant or
-- disabled cron is dead weight in an index whose only query is "what is due now".
--
-- The predicate is a bare literal, so the due query must filter *positively* with a literal
-- `WHERE enabled` — `enabled = $1` is a parameter the planner cannot prove implies this predicate,
-- and would sequential-scan while still paying the index's write cost. Same trap 0006 documents.
CREATE INDEX crons_due_idx
  ON crons (next_run_date)
  WHERE enabled;

-- Search filters by assistant, by thread, and by metadata containment. Only the metadata index is
-- worth its write cost up front: crons is a low-cardinality table (schedules are created by hand,
-- not one per turn like runs), so a sequential scan is cheap and sort indexes would be maintenance
-- with no reader. Add composites here if a deployment ever proves a search sort slow.
CREATE INDEX crons_metadata_idx ON crons USING gin (metadata jsonb_path_ops);

-- Down Migration

DROP INDEX IF EXISTS crons_metadata_idx;
DROP INDEX IF EXISTS crons_due_idx;
DROP TABLE IF EXISTS crons;
