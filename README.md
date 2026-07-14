# skein-js

**A TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs) — and a drop-in replacement for the LangGraph CLI.**

skein-js lets you self-host your LangGraph.js graphs behind the standard Agent Protocol API,
from any Node HTTP framework (Express first; Fastify and NestJS to follow). Think of it as
[**aegra**](https://github.com/aegra/aegra) for the TypeScript ecosystem: zero vendor
lock-in, full control over your agent infrastructure, and the same client tooling you
already use.

**Reuse-first.** On JavaScript, the Agent Protocol server internals are already open
([`@langchain/langgraph-api`](https://www.npmjs.com/package/@langchain/langgraph-api), MIT),
so skein-js doesn't rebuild them. It reuses the LangGraph runtime, checkpointers, `langgraph.json`
parser, schemas, and SDK/types, and adds only the durable-production, multi-framework, and
drop-in-CLI layer that OSS lacks. See [docs/reuse.md](./docs/reuse.md).

> **skein-js** _(noun)_ — a coiled length of thread. The Agent Protocol's first-class
> **threads**, and the strands of a graph.

## The drop-in promise

Already using the LangGraph CLI? Switch by changing one word in your `package.json` — and
keep your existing `langgraph.json` **unchanged**:

```diff
  "scripts": {
-   "dev": "langgraph dev",
-   "up":  "langgraph up"
+   "dev": "skein dev",
+   "up":  "skein up"
  }
```

Your existing clients keep working against `localhost` with only a URL change:

- **`@langchain/langgraph-sdk`** — the vanilla JS client (`client.threads` / `client.runs` / …)
- **`@langchain/langgraph-sdk/react`** — the **`useStream`** hook, streaming over SSE
- **[Agent Chat UI](https://github.com/langchain-ai/agent-chat-ui)** and **LangGraph Studio**

## Why skein-js

|                           | LangGraph Platform | aegra            | **skein-js**                          |
| ------------------------- | ------------------ | ---------------- | ------------------------------------- |
| Self-hosted               | ❌ hosted          | ✅               | ✅                                    |
| Language                  | —                  | Python / FastAPI | **TypeScript / Node**                 |
| HTTP framework            | —                  | FastAPI          | **Express / Fastify / NestJS**        |
| Agent Protocol            | ✅                 | ✅               | ✅                                    |
| Drop-in for LangGraph CLI | —                  | partial          | **✅ (`skein dev` / `up` / `build`)** |

## Status

🚧 **Pre-alpha, but end-to-end — dev _and_ self-hosted production both work today.** In place:

- **`skein dev`** — an in-process dev server that runs an unchanged `langgraph.json` with no Docker:
  TypeScript graphs loaded via vite, state-preserving hot reload, and on-disk persistence across
  restarts.
- **Self-hosted production** — **`skein up`** brings up your own Docker Compose stack (app +
  Postgres + Redis); **`skein build`** / **`skein dockerfile`** generate the image. A shared
  [`@skein-js/runtime`](./packages/runtime) assembles the same engine for dev and prod.
- **Durable drivers** — a Postgres [`SkeinStore`](./packages/storage-postgres) (+ **pgvector**
  semantic search and `PostgresSaver` checkpoints) and a Redis [queue + cross-instance streaming
  bus](./packages/runtime-redis). Develop against them without Docker via
  `skein dev --store postgres --queue redis`.
- **Long-term memory** — the store is injected into graph runs as a LangGraph `BaseStore`, so nodes
  use `getStore()` for cross-thread memory (see [docs/storage.md](./docs/storage.md)).

The remaining MVP work is the **Fastify + NestJS adapters** (Express ships today). See the
[roadmap](./docs/roadmap.md).

## Try it from source

```bash
pnpm install
pnpm nx build cli                     # builds the `skein` binary

cd examples/migrated-langgraph        # a stock LangGraph project, unchanged
pnpm dev                              # → skein dev, http://127.0.0.1:2024
```

In another terminal, talk to it with the official SDK (or point the Agent Chat UI at the same URL,
graph id `agent`):

```bash
TID=$(curl -s -X POST http://127.0.0.1:2024/threads -H 'content-type: application/json' -d '{}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["thread_id"])')

curl -s -X POST "http://127.0.0.1:2024/threads/$TID/runs/wait" \
  -H 'content-type: application/json' \
  -d "{\"assistant_id\":\"agent\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}}"
```

Edit `examples/migrated-langgraph/src/graph.ts` and save — the server hot-reloads while keeping your
threads. `Ctrl-C` and restart — state is restored from `.skein/`. Full walkthrough and the
end-to-end test: [examples/migrated-langgraph](./examples/migrated-langgraph/README.md).

## Using skein-js

### The CLI — a drop-in for the LangGraph CLI

Point it at an existing `langgraph.json`; the graph code and config are unchanged.

```bash
skein dev                              # in-process dev server, hot reload, no Docker (port 2024)
skein dev --store postgres --queue redis   # dev against production-shaped storage (DATABASE_URL / REDIS_URL)
skein up                               # self-hosted stack via Docker Compose: app + Postgres + Redis
skein build -t my-agent                # build a deployable Docker image
skein dockerfile -o Dockerfile         # emit a standalone Dockerfile
```

### Embed it in your own Node server

Serve a `langgraph.json` from an Express app — the zero-setup path wires in-memory drivers:

```ts
import { createExpressServer } from "@skein-js/express";

const server = await createExpressServer({ config: "./langgraph.json" });
await server.listen(2024);
```

Or mount the Agent Protocol on an existing app, and bring your own production drivers through the
`deps` seam ([`@skein-js/runtime`](./packages/runtime) assembles them):

```ts
import { skeinRouter } from "@skein-js/express";
import { buildRuntime } from "@skein-js/runtime";

const runtime = await buildRuntime({ configPath, store: "postgres", queue: "redis" });
const { router } = await skeinRouter({ deps: runtime.deps, cors: runtime.cors });
app.use(router);
```

### What you get

- **Assistants** auto-registered from your `langgraph.json` graphs, with schema introspection.
- **Threads** with persistent state/history and **human-in-the-loop** interrupt/resume (LangGraph
  checkpointers — `MemorySaver` in dev, `PostgresSaver` in prod).
- **Three run modes** — `wait`, `stream`, and background — over one engine.
- **SSE streaming** (`useStream`, Agent Chat UI, the vanilla SDK) with reconnect/replay via
  `Last-Event-ID`, fanned across instances by Redis in production.
- **Long-term memory** — a namespaced store with pgvector semantic search, injected into runs as a
  LangGraph `BaseStore` (`getStore()`).
- **CORS** driven by `langgraph.json`'s `http.cors`, matching the LangGraph CLI.

## Examples

Each is a runnable project; see its README to run it.

| Example                                               | What it proves                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`chat-app`](./examples/chat-app)                     | **Flagship** — a Gemini research assistant (thinking + web search + long-term memory) with a Next.js + shadcn/ui chat UI; full unit / SDK / Playwright tests |
| [`migrated-langgraph`](./examples/migrated-langgraph) | The drop-in proof — a stock LangGraph project under `skein dev`, with hot reload + `.skein/` persistence                                                     |
| [`gemini-chat`](./examples/gemini-chat)               | Model-backed end-to-end — a Gemini ReAct agent streamed into a browser                                                                                       |
| [`express-basic`](./examples/express-basic)           | Zero-setup `echo` + a Claude `agent` graph in one config                                                                                                     |
| [`react-usestream`](./examples/react-usestream)       | Minimal `useStream` SSE-compatibility harness                                                                                                                |

## Packages

An Nx monorepo of small, single-purpose packages. Each has its own README with install
instructions, a usage guide, and an API reference — **click the package name** to open it.

### Contract & engine

| Package                                                 | Purpose                                                                                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [`@skein-js/core`](./packages/core)                     | The shared contract — Agent Protocol wire types, the `SkeinStore` / queue / bus / auth interfaces, and the edge error type |
| [`@skein-js/agent-protocol`](./packages/agent-protocol) | The framework-agnostic engine — run engine, handler table, SSE mapping. Depends only on `core`; independently publishable  |

### Config & runtime wiring

| Package                                   | Purpose                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`@skein-js/config`](./packages/config)   | Loads an unchanged `langgraph.json`, validates it, and resolves each `path:export` graph + its schemas    |
| [`@skein-js/runtime`](./packages/runtime) | Assembles a production `ProtocolDeps` (memory / Postgres / Redis) from `langgraph.json` — used by the CLI |

### Storage & queue drivers

| Package                                                     | Purpose                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`@skein-js/storage-memory`](./packages/storage-memory)     | Zero-dependency in-memory `SkeinStore` + queue + bus (dev / tests)                          |
| [`@skein-js/storage-postgres`](./packages/storage-postgres) | Postgres `SkeinStore` with **pgvector** semantic search; reuses `PostgresSaver` checkpoints |
| [`@skein-js/redis`](./packages/runtime-redis)               | Redis job queue (BullMQ) + cross-instance pub/sub streaming bus                             |

### HTTP adapters

| Package                                          | Purpose                                                  |
| ------------------------------------------------ | -------------------------------------------------------- |
| [`@skein-js/express`](./packages/server-express) | Express adapter — the v1 framework adapter (ships today) |
| [`@skein-js/fastify`](./packages/server-fastify) | Fastify adapter — 🗺️ planned                             |
| [`@skein-js/nestjs`](./packages/server-nestjs)   | NestJS adapter — 🗺️ planned                              |

### CLI & tooling

| Package                                             | Purpose                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`skein-js`](./packages/cli)                        | The `skein` CLI — `dev` / `up` / `build` / `dockerfile`                        |
| [`@skein-js/test-support`](./packages/test-support) | _(private)_ Testcontainers helpers + the shared `SkeinStore` conformance suite |

> Package names are the npm names; a few on-disk directories differ (`@skein-js/express` →
> `packages/server-express`, `@skein-js/redis` → `packages/runtime-redis`, `skein-js` →
> `packages/cli`). The links above point at the directories.

Read the full design in [`docs/`](./docs):

- [Overview & vision](./docs/index.md)
- [Reuse-first architecture](./docs/reuse.md) — what we reuse vs. rebuild
- [Code practices](./docs/code-practices.md) — readable, functional, simple
- [Agent Protocol surface](./docs/agent-protocol.md)
- [LangGraph CLI compatibility](./docs/langgraph-cli-compat.md)
- [Streaming (SSE)](./docs/streaming.md)
- [React SDK / `useStream`](./docs/react-sdk.md)
- [Storage](./docs/storage.md)
- [Runs & Redis](./docs/runs-and-redis.md)
- [Roadmap](./docs/roadmap.md)

## License

[Apache-2.0](./LICENSE)
