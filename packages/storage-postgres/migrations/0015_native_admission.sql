-- Up Migration

CREATE TABLE native_resume_reservations (
  expected_run_id text PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE TABLE native_dispatches (
  run_id text PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('run','cancel')),
  action text,
  not_before timestamptz NOT NULL,
  token uuid,
  lease_until timestamptz,
  dispatched boolean NOT NULL DEFAULT false
);
CREATE INDEX native_dispatches_due ON native_dispatches(lease_until,run_id) WHERE kind='cancel' AND NOT dispatched;

-- Down Migration

DROP TABLE IF EXISTS native_dispatches;
DROP TABLE IF EXISTS native_resume_reservations;
