# Storage

**What this gives you:** durable agents and **long-term memory** that outlives a single
conversation, with zero setup in dev. Threads, runs, and stored memories survive restarts, and inside
a graph node you get a LangGraph-native store — `getStore()` — for cross-thread facts ("prefers window
seats") backed by **pgvector semantic search** in production. It's the same store LangGraph Platform
auto-provides, so a graph that calls `getStore()` runs unchanged on skein-js. The best part: you write
your graph once and skein-js swaps the backend for you — **in-memory in `skein dev`, Postgres +
pgvector in production** — no code change. The flagship [`chat-app`](../examples/chat-app) example uses
this to remember a user across sessions.

skein-js separates two kinds of persistence, and it is important not to conflate them:

1. **Graph checkpoints** — LangGraph's own state/history for a thread (this is what powers
   **interrupt/resume** and history). **Reused, never reimplemented:** delegated to an existing
   LangGraph checkpointer (`MemorySaver` in dev, `PostgresSaver` in prod;
   `@langchain/langgraph-checkpoint-redis` and `-sqlite` are also available). See [reuse.md](./reuse.md).
2. **Protocol resources** — assistants, thread metadata/status, run rows, and long-term
   store items. These are the gap OSS keeps _in memory_, so skein-js owns them behind a single
   `SkeinStore` interface with durable drivers.

## Contents

- [`SkeinStore` interface](#skeinstore-interface)
- [Drivers](#drivers)
- [Checkpointer selection](#checkpointer-selection)
- [Why the split matters](#why-the-split-matters)

## `SkeinStore` interface

A single interface, implemented by each driver, covering the protocol resources:

```ts
interface SkeinStore {
  // assistants (derived from langgraph.json graphs, plus user-created)
  assistants: AssistantRepo;

  // threads: metadata + status (idle | busy | interrupted | error)
  threads: ThreadRepo;

  // runs: status + queue rows (pending | running | success | error | cancelled)
  runs: RunRepo;

  // long-term memory: namespace/key items with optional semantic search
  store: StoreRepo;
}
```

Each repo exposes CRUD + list/search shaped to the [Agent Protocol](./agent-protocol.md)
endpoints. All drivers are validated against **one shared conformance test suite**, so
memory and Postgres behave identically.

### Long-term memory in the graph (`getStore()`)

The `store` repo isn't only reachable over the `/store/items` HTTP endpoints — it is also injected
into **every graph run** as a LangGraph [`BaseStore`](https://langchain-ai.github.io/langgraphjs/reference/classes/checkpoint.BaseStore.html),
alongside the checkpointer. A node reads and writes cross-thread memory the LangGraph-native way:

```ts
import { getStore } from "@langchain/langgraph";

async function remember(state) {
  const store = getStore(); // the run's SkeinStore.store, as a BaseStore
  await store.put(["memories", userId], "prefs", { units: "metric" });
  const hits = await store.search(["memories", userId], { query: "units" }); // pgvector in Postgres
  return { ... };
}
```

This is what makes skein a faithful drop-in: LangGraph Platform auto-provides a store to graphs, so
a graph that calls `getStore()` runs unchanged on skein. The bridge is `SkeinBaseStore` in
[`@skein-js/agent-protocol`](../packages/agent-protocol), attached in the run engine the same way the
checkpointer is. Semantic `search` uses pgvector on the Postgres driver and a naive scan on memory —
both come from the same `StoreRepo`, so behavior matches.

### Store item TTL

Store items can expire, matching LangGraph's store TTL. Configure it in `langgraph.json` under
`store.ttl` (all durations in **minutes**):

```json
{
  "store": { "ttl": { "default_ttl": 1440, "refresh_on_read": true, "sweep_interval_minutes": 60 } }
}
```

- `default_ttl` — lifetime applied to a `put` that doesn't pass its own `ttl`. A `PUT /store/items`
  body may include a per-item `ttl` (minutes) that overrides the default for that item.
- `refresh_on_read` (default `true`) — a `get` extends a live item's expiry by its own TTL.
- `sweep_interval_minutes` (default `60`) — how often the background sweeper deletes expired rows.

Expiry is enforced two ways: **lazily** (an expired item reads as absent from `get`/`search`/
`listNamespaces` even before it's swept) and by the **sweeper** (a periodic `DELETE`). With no
`store.ttl` set, items never expire. The sweeper runs in the production runtime (`skein up`/`build`,
and `skein dev --store postgres`); pure in-memory `skein dev` still enforces expiry lazily on read.

## Drivers

### `@skein-js/storage-memory` (dev/tests)

- In-process maps; zero external dependencies.
- Paired with an in-memory queue and a `MemorySaver` checkpointer for `skein dev`.
- `store` semantic search falls back to a naive scan/embedding compare.

### `@skein-js/storage-postgres` (prod)

- Backed by `pg`; owns tables for assistants/threads/runs/store items + migrations.
- Uses **`@langchain/langgraph-checkpoint-postgres`** (`PostgresSaver.fromConnString`) for
  graph checkpoints — we wrap it rather than reimplement checkpointing.
  <https://www.npmjs.com/package/@langchain/langgraph-checkpoint-postgres>
- **pgvector** for semantic store search, configured from `langgraph.json`'s
  `store.index.{embed, dims, fields}` (see [langgraph-cli-compat.md](./langgraph-cli-compat.md)).
  pgvector is **opt-in**: the base schema needs no extension, so skein runs on a stock managed
  Postgres out of the box. Only when `store.index` is set does `migrate()` run
  `CREATE EXTENSION IF NOT EXISTS vector` and add the `embedding` column — which requires a Postgres
  that ships pgvector (see [deploy-railway.md](./deploy-railway.md)).

```ts
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

const checkpointer = PostgresSaver.fromConnString(process.env.POSTGRES_URI!);
await checkpointer.setup(); // idempotent migrations for checkpoint tables
```

## Checkpointer selection

| `langgraph.json` `checkpointer` | skein-js uses                      |
| ------------------------------- | ---------------------------------- |
| absent (dev / `skein dev`)      | `MemorySaver`                      |
| `"default"`                     | `PostgresSaver` (Postgres)         |
| `"custom"`                      | user-supplied checkpointer (later) |

## Why the split matters

Keeping protocol resources (`SkeinStore`) separate from LangGraph checkpoints means:

- We can offer an in-memory dev experience with no database.
- Postgres parity is proven by running the **same conformance suite** against both drivers.
- Checkpoint format stays 100% LangGraph-native, so thread history/history endpoints and
  interrupt/resume behave exactly as LangGraph expects.
