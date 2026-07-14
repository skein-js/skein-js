-- Up Migration

-- pgvector powers semantic search on the long-term store (docs/storage.md).
CREATE EXTENSION IF NOT EXISTS vector;

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

-- Long-term store items. `embedding` is an unindexed pgvector column (dimensionless), populated
-- only when a store index is configured; semantic search then ranks by cosine distance. Without
-- an index it stays null and search falls back to naive text matching (matching the memory driver).
CREATE TABLE store_items (
  namespace  text[]      NOT NULL,
  key        text        NOT NULL,
  value      jsonb       NOT NULL,
  embedding  vector,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, key)
);

-- Down Migration

DROP TABLE store_items;
DROP TABLE runs;
DROP TABLE threads;
DROP TABLE assistants;
