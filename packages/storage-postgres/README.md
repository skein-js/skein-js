# @skein-js/storage-postgres

> Production Postgres `SkeinStore` driver with **pgvector** semantic search.

Part of **[skein-js](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — implemented; passes the shared `SkeinStore` conformance suite (integration tests need Docker).

## What it does

A production `SkeinStore` over [`pg`](https://node-postgres.com): it owns the assistants / threads /
runs / store-item tables and their migrations, and is held to the **same shared conformance suite**
as the memory driver, so the two are provably interchangeable.

- **Migrations** are applied by `store.migrate()` via
  [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate) (SQL files under `migrations/`,
  tracked in a `skein_migrations` table). Idempotent — safe to call on every boot.
- **Semantic store search** uses **pgvector** when a `store.index` (with an embedder) is configured
  on `connect`; each item's value is embedded and `search({ query })` ranks by cosine distance.
  Without an index, `search` falls back to naive text matching — identical to the memory driver.

Graph **checkpoints are not here** — those stay LangGraph-native via `PostgresSaver` (wired
separately by [`@skein-js/runtime`](../runtime)). This store owns only the protocol resource rows.

## Install

```bash
pnpm add @skein-js/storage-postgres
```

- `pg` and `node-pg-migrate` are **bundled** — you do not install them separately.
- Peer dependency: **`@langchain/langgraph-checkpoint-postgres`** (the `PostgresSaver` this pairs
  with for checkpoints — used by the runtime, not by this package's own code).

## Usage

The connection URL is passed **explicitly** (this package never reads `DATABASE_URL` itself):

```ts
import { PostgresSkeinStore } from "@skein-js/storage-postgres";

const store = await PostgresSkeinStore.connect(process.env.DATABASE_URL!);
await store.migrate(); // idempotent; applies pending migrations
// …later, on shutdown:
await store.close();
```

With pgvector semantic search — pass a `store.index` with an embedder (`dims` must match the
embedder's output length, or the store throws):

```ts
const store = await PostgresSkeinStore.connect(process.env.DATABASE_URL!, {
  index: { dims: 1536, fields: ["content"], embed: async (texts) => embedBatch(texts) },
});
await store.migrate();
```

In practice you rarely call this yourself — `skein dev --store postgres` / `skein up` and
[`@skein-js/runtime`](../runtime) resolve `DATABASE_URL` and the `store.index.embed` from your
`langgraph.json` and construct the store for you.

## API

- **`PostgresSkeinStore.connect(url, options?): Promise<PostgresSkeinStore>`** — the static factory
  (the constructor is private). Creates a `pg.Pool`; does **not** migrate.
- **`store.migrate(): Promise<void>`** — apply pending migrations (idempotent).
- **`store.close(): Promise<void>`** — end the pool. **`store.truncateAll()`** — test helper.
- Repos `assistants` / `threads` / `runs` / `store` — the [`SkeinStore`](../core) interface, with
  Postgres FK `ON DELETE CASCADE` for thread→runs and pgvector cosine ranking on `store.search`.
- **`interface PostgresSkeinStoreOptions`** — `{ index?: StoreIndexConfig }`.
- **`interface StoreIndexConfig`** — `{ dims: number; fields?: string[]; embed: EmbedFunction }`
  (`fields` default `["$"]` = embed the whole value as JSON).
- **`type EmbedFunction`** — `(texts: string[]) => Promise<number[][]>`.

## Reuse

Pairs with `@langchain/langgraph-checkpoint-postgres` (`PostgresSaver`) for graph checkpoints —
skein-js only adds tables for protocol resources and a pgvector column for semantic store search.
(The `PostgresSaver` wiring lives in [`@skein-js/runtime`](../runtime); the peer dep here documents
the pairing.)

## Learn more

- [Storage](../../docs/storage.md) · [Testing](../../docs/testing.md)
- [skein-js overview](../../docs/index.md) · [Reuse-first architecture](../../docs/reuse.md)

## License

[Apache-2.0](../../LICENSE)
