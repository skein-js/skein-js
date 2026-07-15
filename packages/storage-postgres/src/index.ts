// @skein-js/storage-postgres — Postgres SkeinStore driver with pgvector semantic search.
// Graph checkpoints stay LangGraph-native via PostgresSaver (not part of this store).
// See docs/storage.md and docs/testing.md.

export {
  createPostgresPool,
  PostgresSkeinStore,
  type EmbedFunction,
  type PostgresPoolOptions,
  type PostgresSkeinStoreOptions,
  type StoreIndexConfig,
} from "./postgres-skein-store.js";
