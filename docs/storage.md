# Storage

Skein separates two kinds of persistence, and it is important not to conflate them:

1. **Graph checkpoints** — LangGraph's own state/history for a thread. **Reused, never
   reimplemented:** delegated to an existing LangGraph checkpointer (`MemorySaver` in dev,
   `PostgresSaver` in prod; `@langchain/langgraph-checkpoint-redis` and
   `-sqlite` are also available). See [reuse.md](./reuse.md).
2. **Protocol resources** — assistants, thread metadata/status, run rows, and long-term
   store items. These are the gap OSS keeps *in memory*, so Skein owns them behind a single
   `SkeinStore` interface with durable drivers.

## `SkeinStore` interface

A single interface, implemented by each driver, covering the protocol resources:

```ts
interface SkeinStore {
  // assistants (derived from langgraph.json graphs, plus user-created)
  assistants: AssistantRepo;

  // threads: metadata + status (idle | interrupted | errored | finished)
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

## Drivers

### `@skein/storage-memory` (dev/tests)

- In-process maps; zero external dependencies.
- Paired with an in-memory queue and a `MemorySaver` checkpointer for `skein dev`.
- `store` semantic search falls back to a naive scan/embedding compare.

### `@skein/storage-postgres` (prod)

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

| `langgraph.json` `checkpointer` | Skein uses |
| --- | --- |
| absent (dev / `skein dev`) | `MemorySaver` |
| `"default"` | `PostgresSaver` (Postgres) |
| `"custom"` | user-supplied checkpointer (later) |

## Why the split matters

Keeping protocol resources (`SkeinStore`) separate from LangGraph checkpoints means:

- We can offer an in-memory dev experience with no database.
- Postgres parity is proven by running the **same conformance suite** against both drivers.
- Checkpoint format stays 100% LangGraph-native, so thread history/history endpoints and
  interrupt/resume behave exactly as LangGraph expects.
