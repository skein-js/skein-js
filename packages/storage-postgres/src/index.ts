// @skein-js/storage-postgres — Postgres SkeinStore driver with pgvector semantic search.
// Graph checkpoints stay LangGraph-native via PostgresSaver (not part of this store).
// See docs/storage.md and docs/testing.md.

export {
  PostgresSkeinStore,
  type EmbedFunction,
  type PostgresSkeinStoreOptions,
  type StoreIndexConfig,
} from "./postgres-skein-store.js";
