-- Up Migration
--
-- Why a run failed, on the run row — and on the thread row, matching the SDK's `Thread.error`.
--
-- Before this, a failed run stored only `status = 'error'`; the message lived in the thread's
-- `metadata.error`, which the next successful run clears. So `GET /threads/{tid}/runs/{rid}` could
-- never say what went wrong after the fact, and the message existed in-band only for as long as the
-- SSE stream was open.
--
-- `runs.error` holds the JSON-safe `RunError` (`{ error, message, name, cause?, errors?, stack? }`)
-- — the same payload the `error` SSE frame carries, so the stream and the run row can never
-- disagree. `threads.error` is the human-readable message only: the thread mirrors the *latest*
-- turn, while the run row is the durable per-run record.
--
-- Both are NULL for every run and thread that did not fail, including every existing row, so this
-- is a pure add with no backfill.

ALTER TABLE runs ADD COLUMN error jsonb;
ALTER TABLE threads ADD COLUMN error text;

-- Down Migration

ALTER TABLE threads DROP COLUMN error;
ALTER TABLE runs DROP COLUMN error;
