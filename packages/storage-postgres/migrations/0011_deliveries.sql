-- Up Migration
--
-- The outbox for run-completion webhooks, so the news that a run finished is as durable as the run.
--
-- Today the notification is one bare POST fired after the run's terminal status is already committed.
-- A receiver redeploying for ten seconds loses it permanently while the run row still reads
-- 'success', and nothing records that it was lost. The fix is not retries — a caller can write those
-- — it is that the row below is inserted in the *same transaction* as the run's terminal status, so
-- there is no instant at which a run has finished and nobody is going to be told.

CREATE TABLE deliveries (
  delivery_id      text        PRIMARY KEY,
  -- Deliberately NO foreign key on either id, and this is load-bearing rather than an omission. A
  -- stateless run's server-created thread is deleted the moment the run settles, which cascades the
  -- run row away — so the delivery that reports on it would be destroyed microseconds after being
  -- written, breaking exactly the "an external service drives skein and gets the answer back" case
  -- this table exists for. The same argument idempotency_records makes, reached from the other side.
  run_id           text        NOT NULL,
  thread_id        text        NOT NULL,
  -- The absolute http(s) target, as validated at run-create time.
  url              text        NOT NULL,
  -- The body to send, minus its `status` (see run_status). Stored rather than re-rendered at send
  -- time because, per the note above, a retry an hour later has neither a run row nor a checkpoint
  -- left to render from. NULL once delivered, which is what keeps steady-state size proportional to
  -- in-flight deliveries rather than to every delivery ever made.
  payload          jsonb,
  -- True when `values` was replaced by a truncation marker to fit the configured payload cap. The
  -- marker sits *inside* the body, so a receiver is never misled about having the whole state.
  payload_truncated boolean    NOT NULL DEFAULT false,
  -- The run's effective terminal status at the instant this row was written — the status the
  -- transaction actually committed, which is not always the one the caller asked for, because a
  -- cancel may have won. Merged into the body at send time so a callback can never disagree with the
  -- run it describes, and the only record of how the run ended once the run row is gone.
  run_status       text        NOT NULL,
  -- 'pending' | 'delivering' | 'delivered' | 'dead'.
  status           text        NOT NULL,
  attempt          integer     NOT NULL DEFAULT 0,
  -- When this row next becomes claimable, and — while 'delivering' — the lease deadline. One column
  -- for both is what lets a worker killed mid-POST be recovered with no reclaim path: an expired
  -- lease is simply due again, exactly as an expired idempotency claim is taken over rather than
  -- swept.
  next_attempt_at  timestamptz NOT NULL,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- When a *terminal* row may be reclaimed.
  expires_at       timestamptz NOT NULL
);

-- The delivery worker's only query, and the one that runs on every tick of every instance. Partial,
-- so the index holds only in-flight rows rather than every delivery ever made — the same shape
-- runs_inflight_created_at_idx has. The predicate is spelled with bare literals, not parameters, or
-- the planner will not match it against the partial index (the trap 0006 documents).
--
-- delivery_id joins the key so the claim's ORDER BY is total: next_attempt_at ties at millisecond
-- resolution across a burst of runs finishing together, and a claim that is not deterministically
-- ordered can starve its oldest rows.
CREATE INDEX deliveries_due_idx
  ON deliveries (next_attempt_at, delivery_id)
  WHERE status IN ('pending', 'delivering');

-- Listing a run's deliveries, newest first with the delivery_id tie-break the repo contract
-- promises. Not partial: this read wants terminal rows most of all — a delivered or dead one is the
-- whole point of looking.
CREATE INDEX deliveries_run_idx ON deliveries (run_id, created_at DESC, delivery_id DESC);

-- The retention sweep. Partial, because only a terminal row is ever sweepable and an in-flight one
-- has no business being matched by a DELETE.
CREATE INDEX deliveries_expires_at_idx
  ON deliveries (expires_at)
  WHERE status IN ('delivered', 'dead');

-- Down Migration

DROP INDEX IF EXISTS deliveries_expires_at_idx;
DROP INDEX IF EXISTS deliveries_run_idx;
DROP INDEX IF EXISTS deliveries_due_idx;
DROP TABLE IF EXISTS deliveries;
