# @skein-js/runtime

Assembles a skein-js [`ProtocolDeps`](../agent-protocol/src/deps.ts) from a `langgraph.json`
plus a chosen set of drivers, and hands it to any framework adapter through the injectable
`{ deps }` seam. This is the piece that lets `skein dev` and `skein up` run the **same** engine
against either the zero-setup in-memory drivers or production-shaped Postgres + Redis.

```ts
import { buildRuntime } from "@skein-js/runtime";

const runtime = await buildRuntime({
  configPath: "/abs/path/to/langgraph.json",
  store: "postgres", // "memory" | "postgres"  (postgres reads DATABASE_URL)
  queue: "redis", //    "memory" | "redis"     (redis reads REDIS_URL)
});

const server = await createExpressServer({ deps: runtime.deps, cors: runtime.cors });
// ... on shutdown:
await runtime.dispose();
```

- **`store: "postgres"`** connects `PostgresSkeinStore` (from `DATABASE_URL`), runs its
  migrations, and uses `PostgresSaver` as the LangGraph checkpointer.
- **`queue: "redis"`** uses the BullMQ run queue + Redis Streams/pub-sub event bus (`REDIS_URL`).
- **`store: "memory"` + `queue: "memory"`** delegates to `@skein-js/express`'s reloadable
  in-memory runtime, so `skein dev`'s hot-reload and cross-restart state persistence still work.

Graph hot-reload (`reloadGraphs()`) works in every mode; `snapshotState`/`hydrateState` are
present only in all-memory mode (durable stores keep their own state).

## Semantic search (`store.index.embed`)

When `store: "postgres"` and `langgraph.json` declares a `store.index`, `buildRuntime` resolves the
`embed` value into an embedder and enables pgvector semantic search — honoring both forms the
LangGraph CLI documents:

- **`"provider:model"`** — e.g. `"openai:text-embedding-3-small"`. Mirrors Python `init_embeddings`:
  the provider prefix selects a `@langchain/<provider>` package (dynamically imported — install it in
  your project, e.g. `@langchain/openai`, and set its API key). Supported prefixes: `openai`,
  `azure_openai`, `cohere`, `google_genai`, `mistralai`, `bedrock`, `ollama`.
- **Custom-function path** — e.g. `"./embeddings.ts:embed"`. The export is either a raw
  `(texts: string[]) => number[][]` (the shape LangGraph documents) or a LangChain `Embeddings`
  instance. Resolved through the same `path:export` loader used for graphs — no extra dependency.

`store.index.dims` is required whenever `embed` is set. Without a `store.index`, Postgres search
falls back to naive text matching (identical to the memory driver).
