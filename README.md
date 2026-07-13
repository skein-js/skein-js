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

🚧 **Pre-alpha — implementation underway.** The foundation is in place: the shared contract
(`@skein-js/core`), the `langgraph.json` loader (`@skein-js/config`), the in-memory driver
(`@skein-js/storage-memory`), and the framework-agnostic **run engine + Agent Protocol handlers**
(`@skein-js/agent-protocol`) — assistants, threads, the three run modes, the store, SSE streaming, and
interrupt/resume, all unit-tested against real LangGraph. Next up: the Express adapter and `skein
dev`. See the [roadmap](./docs/roadmap.md).

## Architecture

An Nx monorepo of small packages:

| Package                                  | Purpose                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@skein-js/core`                         | The shared contract — Agent Protocol wire types, `SkeinStore` + queue/bus interfaces, edge error                 |
| `@skein-js/agent-protocol`               | Framework-agnostic Agent Protocol engine — run engine, handler table, SSE (the heart); independently publishable |
| `@skein-js/config`                       | `langgraph.json` parser + graph loader (`path:export`)                                                           |
| `@skein-js/express`                      | Express adapter (v1)                                                                                             |
| `@skein-js/fastify` / `@skein-js/nestjs` | Additional adapters (later)                                                                                      |
| `@skein-js/storage-memory`               | In-memory storage driver (dev/tests)                                                                             |
| `@skein-js/storage-postgres`             | Postgres driver + pgvector (prod)                                                                                |
| `@skein-js/redis`                        | Redis job queue + cross-instance pub/sub streaming                                                               |
| `skein-js` (CLI)                         | `skein dev` / `up` / `build` / `dockerfile`                                                                      |

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
