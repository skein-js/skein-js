-- Up Migration
-- skein:concurrent
--
-- `assistant_versions_assistant_id_idx` (0003) indexes `(assistant_id)` on a table whose PRIMARY KEY is
-- already `(assistant_id, version)`. A btree with the same leading column is strictly redundant: the PK
-- serves every query the single-column index could, and serves the ones that matter *better*.
--
-- Both real readers want the composite. `listVersions` is
-- `WHERE assistant_id = $1 ORDER BY version DESC` — the PK gives the filter and the ordering together,
-- where the narrow index gives only the filter and leaves a sort. And the `ON DELETE CASCADE` from
-- `assistants` looks rows up by `assistant_id`, which the PK's leading column answers.
--
-- So its only remaining effect is write amplification: a second index entry to insert on every
-- assistant update (each of which appends an immutable version snapshot) and a second to clean up on
-- every cascade. Same reasoning, and the same fix, as 0005 dropping `runs_thread_id_idx`.
--
-- `skein:concurrent` because DROP INDEX CONCURRENTLY cannot run inside a transaction — and, unlike a
-- plain DROP, it does not take a lock that blocks reads and writes on `assistant_versions` while it runs.

DROP INDEX CONCURRENTLY IF EXISTS assistant_versions_assistant_id_idx;

-- Down Migration

CREATE INDEX assistant_versions_assistant_id_idx ON assistant_versions (assistant_id);
