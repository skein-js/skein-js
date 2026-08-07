-- Up Migration
--
-- Recorded responses for the `Idempotency-Key` header, so a provider's retry of a create gets the
-- original answer instead of a second run.
--
-- Every webhook provider retries — Twilio on timeout or 5xx, Stripe, GitHub, Slack — and without
-- this table each retry means a second reply to the end user, or two agents acting on one event.
-- The row is the arbiter as well as the record: a claim is an INSERT that races on the primary key,
-- so two retries landing on two instances within milliseconds cannot both win.

CREATE TABLE idempotency_records (
  -- What the key is scoped to — "{METHOD} {path} {principal}". The principal is part of the key, not
  -- a filter on top of it: without it, one tenant guessing another's key would replay that tenant's
  -- recorded response, which names a run and a thread they have no other way to see.
  scope       text        NOT NULL,
  -- The caller's header, verbatim. Opaque — never parsed, only compared.
  key         text        NOT NULL,
  -- Hex SHA-256 of the canonicalized request, so the same key sent with a different body is refused
  -- rather than silently answered with the first request's response.
  fingerprint text        NOT NULL,
  -- The token the claiming request holds. `record` and `release` are conditional on it, so a claim
  -- that expired and was taken over cannot have the original's response written on top of it.
  claim_id    text        NOT NULL,
  -- 'in_flight' | 'done'. There is deliberately no 'failed': a recorded failure would pin a
  -- transient 503 for the whole retention, making a momentary outage permanent for that key.
  status      text        NOT NULL,
  -- The verbatim wire response, present only once status is 'done'. Carries the headers as well as
  -- the body — `content-location` is what the SDK reads to fire `onRunCreated`, and a replay that
  -- drops it leaves `useStream` unable to rejoin after a remount.
  response    jsonb,
  -- Deliberately NO foreign key on either id. A replay has to keep working after its run is gone: a
  -- stateless run's server-created thread is deleted on completion and would cascade this record away
  -- microseconds after writing it, breaking idempotency for exactly the retry window this table
  -- exists to cover. Erasure that *should* reach these rows goes through the service layer instead
  -- (see `IdempotencyRepo.deleteByThread`), which can tell a user deleting a thread apart from the
  -- server tidying up an ephemeral one.
  run_id      text,
  thread_id   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- When this record stops being replayable. Written short at claim time (the in-flight window) and
  -- extended to the full retention when the response is recorded, so one column covers both "the
  -- claiming instance died" and "the dedup window is over".
  expires_at  timestamptz NOT NULL,
  -- This composite key IS the constraint a claim races on — there is no separate unique index. An
  -- insert-first claim lets Postgres arbitrate; a read-then-write pair has a window, and that window
  -- is precisely the double-delivery burst this table defends against.
  PRIMARY KEY (scope, key)
);

-- The sweeper's only query. Unconditional rather than partial (unlike store_items_expires_at_idx):
-- every row here has an expiry, so a predicate would exclude nothing and only cost planning.
CREATE INDEX idempotency_records_expires_at_idx ON idempotency_records (expires_at);

-- Deleting a thread erases the records that carry its conversation state. Partial, because only a
-- recorded (`done`) single-thread response ever sets `thread_id` — an in-flight claim has nothing to
-- erase yet, and a batch response spans threads.
CREATE INDEX idempotency_records_thread_idx
  ON idempotency_records (thread_id)
  WHERE thread_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idempotency_records_thread_idx;
DROP INDEX IF EXISTS idempotency_records_expires_at_idx;
DROP TABLE IF EXISTS idempotency_records;
