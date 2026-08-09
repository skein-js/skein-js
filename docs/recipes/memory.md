# Memory

Remembering things across threads and sessions.

## Long-term memory (`getStore()`)

The store is injected into every run as a LangGraph `BaseStore`, so a node reads and writes it the native
way — and the backend swaps (in-memory under `skein dev`, Postgres in production) with no code change.

```ts
import { getStore } from "@langchain/langgraph";

async function remember(state, config) {
  const store = getStore();
  const userId = config.configurable.langgraph_auth_user_id ?? "anon";
  await store.put(["memories", userId], "prefs", { units: "metric" });
  const hits = await store.search(["memories", userId], { query: "units" });
  return { known: hits.map((h) => h.value) };
}
```

The same items are reachable over the `/store/items` HTTP endpoints.

Working versions: [`chat-app`](https://github.com/skein-js/skein-js/tree/main/examples/chat-app) (recalls
a user across sessions) and
[`triage-agent`](https://github.com/skein-js/skein-js/tree/main/examples/triage-agent) (reads your
conventions back into the prompt).

> [!WARNING]
> **Read this before writing a dedup rule**
>
> Both `storage-memory` and Postgres **without** `store.index` return `score: 1` for every text hit — so
> the obvious "score >= 0.9 means duplicate" rule classifies everything as a duplicate and the agent
> **silently stops recording memories**. It does not error. [memory.md](../memory.md) covers this and the
> other shapes that bite.

## Rank by meaning, not substring

On Postgres, configure an embedder and `store.search({ query })` uses pgvector. In-memory falls back to a
naive scan, so dev behaviour matches.

```jsonc
// langgraph.json
{
  "store": { "index": { "embed": "openai:text-embedding-3-small", "dims": 1536, "fields": ["$"] } },
}
```

`embed` takes a `provider:model` string or a function path; `dims` is required with it.

## Expire what you don't need

`store.ttl` (minutes) expires items on a background sweep, with `refresh_on_read` to keep active ones
alive. Threads have their own `checkpointer.ttl`. Both in [storage.md](../storage.md#store-item-ttl).

## Bring your own store

Long-term memory is the one repo you can swap without implementing the other five — point `store.adapter`
at a LangGraph `BaseStore` (including `PostgresStore`, which brings hybrid text+vector search skein's own
driver lacks) or a skein `StoreRepo`. Details:
[storage.md](../storage.md#bringing-your-own-store-storeadapter).
