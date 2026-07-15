-- Up Migration
--
-- The base schema deliberately does NOT require pgvector, so skein runs on a stock managed
-- Postgres (e.g. Railway's default) out of the box. Semantic search is opt-in: when a store index
-- is configured, `PostgresSkeinStore.migrate()` adds the `vector` extension and the `embedding`
-- column on top of this schema (see postgres-skein-store.ts). Everything below is pgvector-free.

-- Assistants derived from langgraph.json graphs, plus user-created ones.
CREATE TABLE assistants (
  assistant_id text PRIMARY KEY,
  graph_id     text        NOT NULL,
  name         text        NOT NULL,
  description  text,
  config       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  context      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  version      integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Threads: metadata + status, plus the graph state values/interrupts mirrored onto the row.
CREATE TABLE threads (
  thread_id        text        PRIMARY KEY,
  status           text        NOT NULL DEFAULT 'idle',
  metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  values           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  interrupts       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  state_updated_at timestamptz NOT NULL DEFAULT now()
);

-- Runs: status + the opaque execution payload (kwargs). Deleting a thread cascades to its runs.
CREATE TABLE runs (
  run_id             text        PRIMARY KEY,
  thread_id          text        NOT NULL REFERENCES threads (thread_id) ON DELETE CASCADE,
  assistant_id       text        NOT NULL,
  status             text        NOT NULL DEFAULT 'pending',
  metadata           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  multitask_strategy text,
  kwargs             jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX runs_thread_id_idx ON runs (thread_id);

-- Long-term store items. Without a configured store index, search falls back to naive text
-- matching (matching the memory driver) and no pgvector is needed. When an index IS configured,
-- migrate() adds an unindexed dimensionless `embedding vector` column here and populates it so
-- semantic search can rank by cosine distance.
CREATE TABLE store_items (
  namespace  text[]      NOT NULL,
  key        text        NOT NULL,
  value      jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, key)
);

-- Down Migration

DROP TABLE store_items;
DROP TABLE runs;
DROP TABLE threads;
DROP TABLE assistants;
