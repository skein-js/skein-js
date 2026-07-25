# @skein-js/runtime

> Assembles a production `ProtocolDeps` (memory / Postgres / Redis) from a `langgraph.json`.

Part of **[skein-js](../../README.md)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — implemented; the assembler behind `skein dev` and `skein up`.

## What it does

`buildRuntime()` assembles a [`ProtocolDeps`](../agent-protocol) from a `langgraph.json` plus a chosen
store/queue driver, and hands it to any framework adapter through the injectable `{ deps }` seam.
This is the one place a production driver combination is selected — so `skein dev` and `skein up` run
the **same** engine against either the zero-setup in-memory drivers or production-shaped
Postgres + Redis. The engine itself stays driver-agnostic.

```ts
import { buildRuntime } from "@skein-js/runtime";
import { createExpressServer } from "@skein-js/express";

const runtime = await buildRuntime({
  configPath: "/abs/path/to/langgraph.json",
  store: "postgres", // "memory" | "postgres"  (postgres reads POSTGRES_URI)
  queue: "redis", //    "memory" | "redis"     (redis reads REDIS_URI)
});

const server = await createExpressServer({ deps: runtime.deps, cors: runtime.cors });
await server.listen(2024);
// …on shutdown:
await runtime.dispose();
```

`store` and `queue` are **required** (no defaults — the CLI supplies its own flag defaults). The
driver branches:

- **`store: "postgres"`** connects `PostgresSkeinStore` (from `POSTGRES_URI`), runs its migrations,
  and uses `PostgresSaver` as the LangGraph checkpointer.
- **`queue: "redis"`** uses the BullMQ run queue + Redis Streams/pub-sub event bus (from `REDIS_URI`).
- **`store: "memory"` + `queue: "memory"`** delegates to [`@skein-js/express`](../server-express)'s
  reloadable in-memory runtime, so `skein dev`'s hot-reload and cross-restart state persistence work.

A missing `POSTGRES_URI` / `REDIS_URI` throws `RuntimeConfigError`; if assembly fails part-way, any
resources already created are disposed before rethrowing, so a failed build leaks nothing.

This is the same environment contract the `skein build` image uses, so anything you learn here
applies when you deploy it — see [deploy anywhere](../../docs/deploy.md) for the full variable table,
pool sizing, and per-platform guides.

Graph hot-reload (`reloadGraphs()`) works in every mode; `snapshotState`/`hydrateState` are present
**only** in all-memory mode (durable stores keep their own state).

> `createExpressServer` is imported from [`@skein-js/express`](../server-express), not from here.
> The shipped `examples/` call `createExpressServer({ config })` directly (the config-path form,
> which uses the in-memory runtime under the hood); `buildRuntime` is the path the CLI uses to add
> Postgres/Redis.

## In-code embedding (Postgres + Redis)

`buildRuntime` assembles durable deps **from a `langgraph.json`**. `embedPostgresGraphs` assembles the
same durable deps **from a graph you already hold in code** — the persistent counterpart to
[`embedInMemoryGraphs`](../server-kit) (which wires only in-memory drivers). Because it owns
pools/connections, it's `async` and returns a `dispose()`:

```ts
import { createExpressServer } from "@skein-js/express";
import { embedPostgresGraphs } from "@skein-js/runtime";
import { graph } from "./my-graph.js";

const { deps, dispose } = await embedPostgresGraphs({ agent: graph }); // reads POSTGRES_URI / REDIS_URI
const server = await createExpressServer({ deps });
await server.listen(2024);
// …on shutdown:
await dispose();
```

Postgres is required (`POSTGRES_URI` or `postgresUri`). **Redis is optional** — with no `redisUri` /
`REDIS_URI`, the run queue + event bus fall back to in-memory: state survives a restart, but you're
limited to a **single instance** (the queue is process-local; streaming isn't fanned across instances).
Options mirror the low-level knobs: `index` (pgvector), `ttl`, `poolMax`, `sslNoVerify`, and `overrides`
for non-driver deps (`auth`/`logger`/…). See [docs/embedding.md](../../docs/embedding.md) for the full
walkthrough.

## Install

```bash
pnpm add @skein-js/runtime
```

Peer dependencies: `@langchain/langgraph` and `@langchain/langgraph-checkpoint-postgres`. Loading
TypeScript graphs/embedders requires passing an `importModule` (the CLI injects a vite loader).

## API

- **`buildRuntime(options): Promise<SkeinRuntime>`** — `options`:
  `{ configPath, store, queue, importModule? }`. Durable deps **from a `langgraph.json`**.
- **`interface SkeinRuntime`** — `{ deps, cors?, reloadGraphs(), dispose(), snapshotState?(), hydrateState?() }`
  (the last two only in all-memory mode).
- **`type StoreDriver`** = `"memory" | "postgres"` · **`type QueueDriver`** = `"memory" | "redis"`.
- **`embedPostgresGraphs(graphs, options?): Promise<EmbeddedPostgresRuntime>`** — durable deps **from
  graphs in code** (Postgres + `PostgresSaver`, Redis when configured). Returns `{ deps, dispose() }`.
  `options`: `{ postgresUri?, redisUri?, index?, ttl?, poolMax?, sslNoVerify?, overrides? }`.
- **`interface EmbedPostgresGraphsOptions`** · **`interface EmbeddedPostgresRuntime`** ·
  re-exported **`type EmbeddableGraph`** (from `@skein-js/server-kit`).
- **`class RuntimeConfigError`** — thrown when a driver's env var or `store.index.embed` can't be
  resolved.
- **`resolveEmbed(embed, { configDir, importModule? })`** — resolves a `langgraph.json`
  `store.index.embed` to an `EmbedFunction` (see below); exported for reuse/testing.

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

`store.index.dims` is required whenever `embed` is set. Without a `store.index`, Postgres search falls
back to naive text matching (identical to the memory driver).

## Learn more

- [Storage](../../docs/storage.md) · [Runs & Redis](../../docs/runs-and-redis.md) · [LangGraph CLI compatibility](../../docs/langgraph-cli-compat.md)
- [skein-js overview](../../docs/index.md) · [Reuse-first architecture](../../docs/reuse.md) · [Root README](../../README.md)

## License

[Apache-2.0](../../LICENSE)
