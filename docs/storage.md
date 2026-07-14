# Storage

skein-js separates two kinds of persistence, and it is important not to conflate them:

1. **Graph checkpoints** — LangGraph's own state/history for a thread. **Reused, never
   reimplemented:** delegated to an existing LangGraph checkpointer (`MemorySaver` in dev,
   `PostgresSaver` in prod; `@langchain/langgraph-checkpoint-redis` and
   `-sqlite` are also available). See [reuse.md](./reuse.md).
2. **Protocol resources** — assistants, thread metadata/status, run rows, and long-term
   store items. These are the gap OSS keeps _in memory_, so skein-js owns them behind a single
   `SkeinStore` interface with durable drivers.

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

```ts
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL!);
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
