-- Up Migration
--
-- Assistant version history. Every `PATCH /assistants/{id}` mints a new immutable snapshot here; the
-- live `assistants` row keeps `version` pointing at the currently-active one and mirrors its fields
-- (so existing readers and the run engine are unchanged). `setLatest` rolls the live row back to an
-- existing snapshot without adding a new one. Deleting an assistant cascades to its versions.

CREATE TABLE assistant_versions (
  assistant_id text        NOT NULL REFERENCES assistants (assistant_id) ON DELETE CASCADE,
  version      integer     NOT NULL,
  graph_id     text        NOT NULL,
  name         text        NOT NULL,
  description  text,
  config       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  context      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assistant_id, version)
);

-- getVersions filters history by assistant_id and orders by version desc.
CREATE INDEX assistant_versions_assistant_id_idx ON assistant_versions (assistant_id);

-- Down Migration

DROP TABLE assistant_versions;
