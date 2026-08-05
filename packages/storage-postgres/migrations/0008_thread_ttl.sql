-- Up Migration
--
-- Thread TTL. `expires_at` is when the thread becomes eligible for deletion; the background sweeper
-- collects rows past it. `ttl_minutes` is the thread's own lifetime, kept so the value a caller set
-- is still legible after the fact. Both are NULL for threads with no TTL (the default), so existing
-- rows are unaffected and stay forever.
--
-- Unlike `store_items`, reads do NOT filter on `expires_at`: expiry here means "may be collected",
-- not "gone". A thread is a container for runs and checkpoints, and hiding one early would make a
-- thread with an in-flight run read as absent while that run was still writing to it.

ALTER TABLE threads ADD COLUMN ttl_minutes double precision;
ALTER TABLE threads ADD COLUMN expires_at  timestamptz;

CREATE INDEX threads_expires_at_idx ON threads (expires_at) WHERE expires_at IS NOT NULL;

-- Down Migration

DROP INDEX threads_expires_at_idx;
ALTER TABLE threads DROP COLUMN expires_at;
ALTER TABLE threads DROP COLUMN ttl_minutes;
