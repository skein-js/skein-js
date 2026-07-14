# @skein-js/storage-postgres

> Postgres SkeinStore driver with pgvector semantic search, reusing PostgresSaver for checkpoints.

Part of **[skein-js](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — implemented; passes the shared `SkeinStore` conformance suite (integration tests need Docker).

## What it does

Production `SkeinStore` over `pg`: owns the assistants / threads / runs / store-item tables and
their migrations, and delegates graph checkpoints to `PostgresSaver` (not part of this store).

```ts
import { PostgresSkeinStore } from "@skein-js/storage-postgres";

const store = await PostgresSkeinStore.connect(process.env.DATABASE_URL!);
await store.migrate(); // idempotent; applies pending migrations
```

- **Migrations** are applied by `store.migrate()` via [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate)
  (SQL files under `migrations/`, tracked in a `skein_migrations` table).
- **Semantic store search** uses **pgvector** when a `store.index` (with an embedder) is configured
  on `connect`; embeddings are stored per item and `search({ query })` ranks by cosine distance.
  Without an index configured, `search` falls back to naive text matching — identical to the memory
  driver, so both pass the same shared conformance suite.

## Reuse

Reuses `@langchain/langgraph-checkpoint-postgres` (`PostgresSaver`) for graph checkpoints — skein-js
only adds tables for protocol resources and a pgvector column for semantic store search.

## Install

```bash
pnpm add @skein-js/storage-postgres
```

## Learn more

- [skein-js overview](../../docs/index.md)
- [Reuse-first architecture](../../docs/reuse.md)
- [Roadmap](../../docs/roadmap.md)

## License

[Apache-2.0](../../LICENSE)
