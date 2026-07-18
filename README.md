# skein-js

**Self-host your LangGraph.js agents behind a standard API — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server that's a drop-in replacement for the LangGraph CLI.**

You built an agent with [LangGraph.js](https://github.com/langchain-ai/langgraphjs). skein-js turns
it into a real server — threads, runs, token streaming, long-term memory, and human-in-the-loop —
that you run on **your own infrastructure**, in TypeScript, with **zero vendor lock-in**. If you're
already using the LangGraph CLI, switching is a one-word change: `langgraph dev` → `skein dev`.

Think of it as [**aegra**](https://github.com/aegra/aegra) for the TypeScript ecosystem.

> **skein** _(noun, /skeɪn/ — "skayn", rhymes with "rain")_ — a coiled length of thread. The Agent
> Protocol's first-class **threads**, and the strands of a graph.

## Contents

- [What problem does this solve?](#what-problem-does-this-solve)
- [Core principles](#core-principles)
- [Quick start](#quick-start)
- [Building rich agent UIs](#building-rich-agent-uis)
- [Using the CLI](#using-the-cli)
- [Embedding skein-js in your own server](#embedding-skein-js-in-your-own-server)
- [Under the hood](#under-the-hood)
- [Packages](#packages)
- [Examples](#examples)
- [Tested end-to-end](#tested-end-to-end)
- [Documentation](#documentation)
- [Contributing & feedback](#contributing--feedback)
- [License](#license)

## What problem does this solve?

Say you've written an agent as a LangGraph.js graph. On its own, a graph is just a function you call
in-process — to put it in front of a chat UI or another service you need an actual **server**, and a
capable agent server is a surprising amount of plumbing:

- **Threads** — conversations that persist across requests, with full state and history.
- **Runs** — a way to execute the graph in three shapes: wait for the answer, **stream** tokens as
  they're generated, or kick it off in the background.
- **Streaming over the wire** — pushing tokens, tool calls, and reasoning to a browser as they
  happen (and letting a client reconnect and replay if the connection drops).
- **Human-in-the-loop** — pausing a run for approval and resuming it later.
- **Long-term memory** — storage that outlives a single conversation.
- **Auth, CORS, persistence, scaling** — the boring-but-essential production concerns.

The **[Agent Protocol](https://github.com/langchain-ai/agent-protocol)** is the open HTTP + SSE
standard that describes all of this. Because it's a standard, any client that speaks it —
[`@langchain/langgraph-sdk`](https://www.npmjs.com/package/@langchain/langgraph-sdk), the
[`useStream`](https://langchain-ai.github.io/langgraphjs/) React hook,
[Agent Chat UI](https://github.com/langchain-ai/agent-chat-ui), LangGraph Studio — works with any
server that implements it.

The **LangGraph CLI** (`langgraph dev` / `up`) gives you such a server locally. But your options for
running it **in production, self-hosted, in TypeScript** are thin:

- **LangGraph Platform** (the managed deployment target, now **LangSmith Deployment**) is a **paid
  product** — self-hosting it in production needs a **commercial Enterprise license**
  ([pricing & licensing below](#a-note-on-langgraph-platform-pricing)).
- The leading _open_, self-hostable alternative, [**aegra**](https://github.com/aegra/aegra), is
  **Python / FastAPI only**.

So a **TypeScript team that wants to truly self-host** — your infra, your data, no license key, no
per-run bill — was stuck choosing between the paid platform, a Python sidecar, or hand-rolling an
HTTP layer around the graph.

**skein-js is that missing piece:** a TypeScript Agent Protocol server you host yourself, and a
drop-in for the LangGraph CLI so your existing `langgraph.json`, graphs, and clients keep working
unchanged.

## Core principles

- **🔁 Drop-in LangGraph CLI compatibility.** `skein dev` / `up` / `build` mirror the LangGraph CLI,
  and your `langgraph.json` stays **unchanged**. Migrating off (or comparing against) the LangGraph
  CLI is a one-word change. If something works under `langgraph dev` but not `skein dev`, that's a
  bug we want to hear about — [please file it](https://github.com/skein-js/skein-js/issues).
- **♻️ Reuse first.** On JavaScript the Agent Protocol server internals are already open source
  ([`@langchain/langgraph-api`](https://www.npmjs.com/package/@langchain/langgraph-api), MIT), so
  skein-js doesn't rebuild them. It reuses the LangGraph runtime, checkpointers, `langgraph.json`
  parser, schemas, and SDK/types, and adds only the durable-production, multi-framework, and
  drop-in-CLI layer that OSS lacks. See [docs/reuse.md](./docs/reuse.md).
- **✨ Rich agent UX out of the box.** Streaming tokens and model **thinking**, structured
  **tool-result cards**, **human-in-the-loop** interrupt/resume, and cross-thread **long-term
  memory** — everything you need to communicate effectively with an agent, not just get a final
  string. See [Building rich agent UIs](#building-rich-agent-uis).
- **🔓 Self-hosted, no lock-in.** Your agents, your infrastructure, your data — Apache-2.0.

|                           | LangGraph Platform                      | aegra            | **skein-js**                             |
| ------------------------- | --------------------------------------- | ---------------- | ---------------------------------------- |
| Self-hosted in production | 💲 Enterprise license only              | ✅ free          | ✅ free                                  |
| License                   | Elastic License 2.0 (source-available)  | MIT              | **Apache-2.0**                           |
| Cost                      | $39/seat/mo + usage; self-host = custom | free             | **free**                                 |
| Language                  | —                                       | Python / FastAPI | **TypeScript / Node**                    |
| HTTP framework            | —                                       | FastAPI          | **Express · Fastify · NestJS · Next.js** |
| Agent Protocol            | ✅                                      | ✅               | ✅                                       |
| Drop-in for LangGraph CLI | —                                       | partial          | **✅ (`skein dev` / `up` / `build`)**    |

### A note on LangGraph Platform pricing

You _can_ self-host **LangGraph Platform** — but production self-hosting is an **Enterprise add-on
that requires a commercial license key** (contact sales), because the platform's server runtime is
source-available under the [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license),
not open source. The managed tiers are paid too: the **Plus** plan is **$39 / seat / month** plus
usage-based deployment pricing (currently ~$0.005 per deployment run and per-minute uptime), and
fully self-hosted / hybrid deployment is **Enterprise-only** with custom pricing. A free
**Self-Hosted Lite** exists but is node-capped and still needs a LangSmith API key.

If you're a **hobbyist or just getting started**, that model isn't ideal — you shouldn't need a
commercial license or a per-run bill to ship a side project. And if the LangGraph Platform license
_does_ make sense for you later (bigger team, SLAs, managed ops), that's fine too: skein-js is built
to make moving **either direction** painless. Because it's a drop-in for the LangGraph CLI on an
**unchanged `langgraph.json`**, switching _from_ LangGraph — or back _to_ it — is a one-word change,
not a migration. Our goal is low lock-in in both directions, so you can start free on skein-js and
adopt the platform if and when it's worth it.

_LangGraph Platform pricing/licensing as of July 2026 — see [langchain.com/pricing](https://www.langchain.com/pricing) and the [self-hosting docs](https://docs.langchain.com/langgraph-platform/self-hosted). Always verify current terms._

> 🚧 **Status: pre-alpha, but end-to-end.** Dev _and_ self-hosted production both work today, with
> Express, Fastify, NestJS, and Next.js adapters. See the [roadmap](./docs/roadmap.md).

## Quick start

A skein-js project is just three pieces: a **graph**, a **`langgraph.json`**, and the **`skein`
CLI**. Nothing in your graph code is skein-specific.

**1. Install the CLI** into your project:

```bash
pnpm add -D skein-js            # or: npm i -D skein-js  ·  yarn add -D skein-js
```

**2. Write a plain LangGraph.js graph** and export it — e.g. `src/graph.ts`:

```ts
import { AIMessage } from "@langchain/core/messages";
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";

export const graph = new StateGraph(MessagesAnnotation)
  .addNode("echo", (state) => ({
    messages: [new AIMessage(`echo: ${state.messages.at(-1)?.content}`)],
  }))
  .addEdge("__start__", "echo")
  .addEdge("echo", "__end__")
  .compile();
```

**3. Point a `langgraph.json` at it** — the same format the LangGraph CLI uses:

```json
{
  "node_version": "20",
  "graphs": { "agent": "./src/graph.ts:graph" },
  "env": ".env"
}
```

**4. Start the server** — no Docker, TypeScript loaded directly, hot reload, state persisted across
restarts:

```bash
pnpm skein dev            # → http://127.0.0.1:2024   (drop-in for `langgraph dev`)
```

**5. Talk to it** with the official SDK (or point Agent Chat UI / Studio at the same URL):

```ts
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://127.0.0.1:2024" });
const thread = await client.threads.create();
const answer = await client.runs.wait(thread.thread_id, "agent", {
  input: { messages: [{ role: "user", content: "hello" }] },
});
console.log(answer);
```

…or with plain `curl`:

```bash
TID=$(curl -s -X POST http://127.0.0.1:2024/threads -H 'content-type: application/json' -d '{}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["thread_id"])')

curl -s -X POST "http://127.0.0.1:2024/threads/$TID/runs/wait" \
  -H 'content-type: application/json' \
  -d "{\"assistant_id\":\"agent\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}}"
```

Edit `src/graph.ts` and save — the server hot-reloads while keeping your threads. `Ctrl-C` and
restart — state is restored from `.skein/`. Already have a LangGraph project? Just change your
`"dev": "langgraph dev"` script to `"dev": "skein dev"` and run it — see
[`examples/migrated-langgraph`](./examples/migrated-langgraph).

## Building rich agent UIs

A modern agent UI shows more than a final answer — it streams reasoning, renders tool results as
cards, and pauses for your approval. skein-js speaks the Agent Protocol over SSE, so the standard
LangChain client tooling gives you all of this with only a URL change. The flagship
[`chat-app`](./examples/chat-app) example is the full reference; here are the building blocks.

**Stream a conversation with `useStream`** — tokens arrive incrementally:

```tsx
import { useStream } from "@langchain/langgraph-sdk/react";

const thread = useStream({ apiUrl: "http://localhost:2024", assistantId: "agent" });

// send a message; `thread.messages` updates live as tokens stream in
thread.submit({ messages: [{ type: "human", content: input }] });
```

**Stream model _thinking_** — when your model emits reasoning (e.g. Gemini's `includeThoughts`), it
arrives as `thinking` content blocks you can render in a collapsible panel, separate from the answer.
See [`docs/streaming.md`](./docs/streaming.md).

**Render tool results as cards** — have a tool return structured JSON, then render it as a weather /
flight / booking card instead of raw text. The [`chat-app`](./examples/chat-app) example dispatches
tool output to rich React components.

**Human-in-the-loop** — a graph node calls LangGraph's `interrupt()` to pause a run; the interrupt
surfaces on the client, and you resume with a `command`:

```tsx
// a pending interrupt (e.g. "approve this flight booking?") is exposed here:
if (thread.interrupt) {
  // ...render an approval card, then resume the paused run:
  thread.submit(undefined, { command: { resume: { approved: true } } });
}
```

skein-js injects a checkpointer automatically, so interrupt/resume works in `skein dev` with no
setup. See [`docs/react-sdk.md`](./docs/react-sdk.md).

**Long-term memory across threads** — inside a graph node, `getStore()` gives you a namespaced,
persistent store that outlives a single conversation. skein-js injects it as a LangGraph
`BaseStore` — in-memory in dev, Postgres with **pgvector semantic search** in production:

```ts
import { getStore } from "@langchain/langgraph";

// inside a node or tool:
const store = getStore();
await store.put(["memories", userId], "fact-1", { text: "prefers window seats" });
const recalled = await store.search(["memories", userId], { query: "seat preference" });
```

See [`docs/storage.md`](./docs/storage.md).

## Using the CLI

Point `skein` at an existing `langgraph.json`; your graph code and config are unchanged.

```bash
skein dev                                  # in-process dev server, hot reload, no Docker (port 2024)
skein dev --store postgres --queue redis   # dev against production-shaped storage (POSTGRES_URI / REDIS_URI)
skein up                                    # self-hosted stack via Docker Compose: app + Postgres + Redis
skein build -t my-agent                     # build a deployable Docker image
skein dockerfile -o Dockerfile              # emit a standalone Dockerfile
```

| Command            | What it does                                                              | LangGraph CLI equivalent |
| ------------------ | ------------------------------------------------------------------------- | ------------------------ |
| `skein dev`        | In-process dev server: vite-loaded TS graphs, hot reload, `.skein/` state | `langgraph dev`          |
| `skein up`         | Production Docker Compose stack (app + Postgres + Redis)                  | `langgraph up`           |
| `skein build`      | Build a deployable Docker image                                           | `langgraph build`        |
| `skein dockerfile` | Emit a standalone Dockerfile                                              | `langgraph dockerfile`   |

Useful `skein dev` flags: `-p, --port` (default 2024), `--host`, `--store memory|postgres`,
`--queue memory|redis`, `--no-persist`, `--no-reload`, `-v, --verbose`. Full mapping and the
annotated `langgraph.json`: [`docs/langgraph-cli-compat.md`](./docs/langgraph-cli-compat.md).

Private production deps? `skein build`/`up` take `-n, --npmrc <path>`, mounting an `.npmrc` as a
BuildKit secret so the image can install from a **private/authenticated npm registry** without baking
a token into any layer.

## Embedding skein-js in your own server

Prefer to run inside your own Node process? There are **two ways in**, both mounting the same Agent
Protocol server.

**Already have a compiled graph in code (no `langgraph.json`, never used the LangGraph Platform)?**
Bring it directly — pass a graph map to `embedInMemoryGraphs` and hand the result to any adapter:

```ts
import { createExpressServer } from "@skein-js/express";
import { embedInMemoryGraphs } from "@skein-js/server-kit";
import { graph } from "./my-graph.js"; // your existing `new StateGraph(...).compile()`

const server = await createExpressServer({ deps: embedInMemoryGraphs({ agent: graph }) });
await server.listen(2024);
```

`embedInMemoryGraphs` turns a graph map into a `ProtocolDeps` (store, queue, bus, checkpointer) — the
`{ deps }` seam **every** adapter accepts, so the same `deps` mounts on Express, Fastify, NestJS, or
Next.js unchanged. See [docs/embedding.md](./docs/embedding.md) and
[`examples/embed-graph`](./examples/embed-graph).

**Have a `langgraph.json`?** Serve it from an Express app — the zero-setup path wires in-memory drivers:

```ts
import { createExpressServer } from "@skein-js/express";

const server = await createExpressServer({ config: "./langgraph.json" });
await server.listen(2024);
```

Or mount the Agent Protocol on an existing app and bring your own production drivers through the
`deps` seam ([`@skein-js/runtime`](./packages/runtime) assembles them):

```ts
import { skeinRouter } from "@skein-js/express";
import { buildRuntime } from "@skein-js/runtime";

const runtime = await buildRuntime({
  configPath: "./langgraph.json",
  store: "postgres",
  queue: "redis",
});
const { router } = await skeinRouter({ deps: runtime.deps, cors: runtime.cors });
app.use(router);
```

## Under the hood

skein-js keeps the **contract** identical to the LangGraph CLI — same `langgraph.json`, same graph
code, same Agent Protocol on the wire — while re-implementing the runtime with an open, self-hostable
toolset:

- **[commander](https://github.com/tj/commander.js)** powers the `skein` CLI.
- **[vite](https://vitejs.dev)** loads your TypeScript graphs in-process for `skein dev` — no build
  step, with **state-preserving hot reload** and `.skein/` persistence across restarts.
- **[BullMQ](https://docs.bullmq.io)** (on Redis) runs the production job queue with retries and
  crash recovery; **[ioredis](https://github.com/redis/ioredis) + Redis Streams** fan run streams
  across instances so a client on one instance can follow a run on another.
- **[pgvector](https://github.com/pgvector/pgvector)** (via `pg` + `node-pg-migrate`) backs
  long-term memory with semantic search, while checkpoints stay LangGraph-native via
  **[`PostgresSaver`](https://www.npmjs.com/package/@langchain/langgraph-checkpoint-postgres)** —
  reused, not reinvented.

Because storage and the queue are **pluggable drivers**, `skein dev` can even run against
production-shaped Postgres/Redis without Docker (`--store postgres --queue redis`). None of this
changes what your clients see. Details: [docs/langgraph-cli-compat.md](./docs/langgraph-cli-compat.md#under-the-hood-what-skein-js-changes-transparently)
and [docs/runs-and-redis.md](./docs/runs-and-redis.md).

## Packages

skein-js is published to npm as a set of small, single-purpose packages. Most users only need the
**CLI** (`skein-js`); the rest are building blocks for embedding, custom drivers, or a bespoke
server. Every package has its own README with install instructions, usage, and an API reference —
**click the package name** to open it.

### `skein-js` — the CLI

The drop-in for the LangGraph CLI; this is the only package most projects install.

```bash
pnpm add -D skein-js
pnpm skein dev
```

→ [`packages/cli`](./packages/cli)

### `@skein-js/agent-protocol` — the engine ⭐

The framework-agnostic heart: a complete implementation of the **Agent Protocol** for LangGraph.js —
run engine, HTTP handler table, and SSE streaming, driven entirely by injected dependencies. Build
your own server on it, on any framework, with any storage/queue.

```bash
pnpm add @skein-js/agent-protocol @skein-js/core
```

```ts
import { createProtocolRuntime } from "@skein-js/agent-protocol";

const runtime = createProtocolRuntime(deps); // service + HTTP handlers + background worker
```

→ [`packages/agent-protocol`](./packages/agent-protocol)

### Framework adapters — Express, Fastify, NestJS, Next.js

Each adapter is a thin transport shim that mounts the Agent Protocol engine on its framework — no
protocol logic of its own, just request/response translation over the shared handler table. Pick the
one matching your stack (or [write your own](./docs/building-an-adapter.md)); the wire format is
identical because they all drive the same engine.

```bash
pnpm add @skein-js/express @langchain/langgraph   # or @skein-js/fastify · @skein-js/nestjs · @skein-js/nextjs
```

```ts
// Express (createExpressServer) / Fastify (createFastifyServer) / NestJS (createNestServer) —
// standalone servers with the same shape:
import { createFastifyServer } from "@skein-js/fastify";
const server = await createFastifyServer({ config: "./langgraph.json" });
await server.listen(2024);

// …or embed alongside your app's own routes:
//   Fastify:  await app.register(skeinPlugin, { prefix: "/agent", config });
//   NestJS:   imports: [SkeinModule.forRoot({ config })]
//   Next.js:  export const { GET, POST, PUT, PATCH, DELETE } = createSkeinRouteHandlers({ config });
```

| Adapter                                          | Serve it as                                          |
| ------------------------------------------------ | ---------------------------------------------------- |
| [`@skein-js/express`](./packages/server-express) | Express `Router` / standalone server                 |
| [`@skein-js/fastify`](./packages/server-fastify) | Fastify plugin / standalone server                   |
| [`@skein-js/nestjs`](./packages/server-nestjs)   | `SkeinModule` / standalone server (Express platform) |
| [`@skein-js/nextjs`](./packages/server-nextjs)   | App Router + Pages Router API routes (same-origin)   |

Shared, framework-agnostic building blocks (the route table lives in the engine; the in-memory
runtime, dev-state import, and CORS mapping in [`@skein-js/server-kit`](./packages/server-kit)) mean
no adapter depends on another.

### `@skein-js/runtime` — production wiring

Assembles a production `ProtocolDeps` (memory / Postgres / Redis) from a `langgraph.json` — the same
wiring the CLI uses. Use it to embed a production-shaped server in your own app.

```bash
pnpm add @skein-js/runtime
```

```ts
import { buildRuntime } from "@skein-js/runtime";
const runtime = await buildRuntime({
  configPath: "./langgraph.json",
  store: "postgres",
  queue: "redis",
});
```

→ [`packages/runtime`](./packages/runtime)

### `@skein-js/config` — `langgraph.json` loader

Parses and validates an unchanged `langgraph.json` and resolves each `path:export` graph plus its
schemas. Handy on its own for tooling.

```bash
pnpm add @skein-js/config
```

```ts
import { loadConfig } from "@skein-js/config";
const config = await loadConfig({ configPath: "./langgraph.json" });
```

→ [`packages/config`](./packages/config)

### `@skein-js/core` — the shared contract

Agent Protocol wire types plus the `SkeinStore` / queue / bus / auth interfaces every other package
implements. Depend on it to build a custom driver or adapter.

```bash
pnpm add @skein-js/core
```

→ [`packages/core`](./packages/core)

### Storage & queue drivers

Pick a store (persistence for threads/runs/memory) and a queue/streaming bus (run scheduling +
cross-instance fan-out). These map directly to the CLI's `--store` and `--queue` flags.

| Package                                                     | Use it for                                                                               | Install                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------- |
| [`@skein-js/storage-memory`](./packages/storage-memory)     | Zero-dependency in-memory store + queue + bus (dev / tests)                              | `pnpm add @skein-js/storage-memory`   |
| [`@skein-js/storage-postgres`](./packages/storage-postgres) | Production Postgres store with **pgvector** semantic search; `PostgresSaver` checkpoints | `pnpm add @skein-js/storage-postgres` |
| [`@skein-js/redis`](./packages/runtime-redis)               | Redis job queue (BullMQ) + cross-instance streaming bus (multi-instance prod)            | `pnpm add @skein-js/redis`            |

### Coming soon

Planned (LangGraph Platform parity): **cron / scheduled runs**, **time travel** (fork from a
checkpoint), and an **MCP endpoint** — see the
[roadmap](./docs/roadmap.md#planned--coming-soon-post-mvp) and
[known gaps](./docs/roadmap.md#known-gaps-vs-the-langgraph-cli--platform). Recently shipped: the
**Fastify, NestJS, and Next.js adapters** (Express was first), **multitask / double-texting**
(`reject`/`enqueue`/`interrupt`/`rollback`), **run-completion webhooks**, a **true `events` stream
mode**, **assistants CRUD + versioning**, thread **search** (metadata/status filter + pagination),
thread **copy** (with history), store item **TTL**, and a distinct **`cancelled`** run status.

> Package names are the npm names; a few on-disk directories differ (`@skein-js/express` →
> `packages/server-express`, likewise `@skein-js/fastify` · `@skein-js/nestjs` · `@skein-js/nextjs` →
> `packages/server-{fastify,nestjs,nextjs}`, `@skein-js/redis` → `packages/runtime-redis`, `skein-js`
> → `packages/cli`). The links above point at the directories.

## Examples

Each is a runnable project — `cd` into it and follow its README.

| Example                                                                               | What you'll learn                                                                                                                                                                                  | How to run                 |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| [`chat-app`](./examples/chat-app)                                                     | **Flagship** — build a full rich-UX chat app: streamed thinking, web search, structured tool-result cards, human-in-the-loop booking, long-term memory, custom auth (Gemini + Next.js + shadcn/ui) | `pnpm dev` + `pnpm dev:ui` |
| [`migrated-langgraph`](./examples/migrated-langgraph)                                 | The **drop-in proof** — a stock LangGraph project under `skein dev`, with hot reload + `.skein/` persistence                                                                                       | `pnpm dev`                 |
| [`gemini-chat`](./examples/gemini-chat)                                               | **Model-backed end-to-end** — a Gemini ReAct agent streamed into a browser; also an embedded `@skein-js/express` server                                                                            | `pnpm dev`                 |
| [`express-basic`](./examples/express-basic)                                           | **Hello world** — zero-setup `echo` (no API key) + a Claude `agent` graph in one config                                                                                                            | `pnpm dev`                 |
| [`embed-graph`](./examples/embed-graph)                                               | **In-code embedding** — serve a graph you already have with **no `langgraph.json`** (`embedInMemoryGraphs` + `{ deps }`); the config-free counterpart to `express-basic`                           | `pnpm dev`                 |
| [`fastify-basic`](./examples/fastify-basic) · [`fastify-app`](./examples/fastify-app) | **Fastify** — a standalone graph server, and the protocol embedded under `/agent` alongside a REST API                                                                                             | `pnpm dev`                 |
| [`nestjs-basic`](./examples/nestjs-basic) · [`nestjs-app`](./examples/nestjs-app)     | **NestJS** — a standalone graph server, and `SkeinModule` alongside the app's own controller                                                                                                       | `pnpm dev`                 |
| [`nextjs-basic`](./examples/nextjs-basic) · [`nextjs-app`](./examples/nextjs-app)     | **Next.js** — headless Pages Router API, and a full-stack App Router app serving the protocol same-origin behind a `useStream` chat UI                                                             | `pnpm dev`                 |
| [`react-usestream`](./examples/react-usestream)                                       | A minimal **`useStream` SSE frontend** you can point at any skein-js server                                                                                                                        | `pnpm dev`                 |

## Tested end-to-end

skein-js is verified in layers — not just unit tests, but real clients driving a real server. The
examples above _are_ the integration/e2e suite:

- **Storage conformance** — every storage driver (memory + Postgres) runs against one shared
  `SkeinStore` conformance suite, so drivers behave identically.
- **SDK conformance (e2e)** — `examples/express-basic` (and the Fastify/NestJS `*-basic` + `*-app`
  examples) are exercised by the **real `@langchain/langgraph-sdk`** client (`threads.create`,
  `runs.stream`, `runs.wait`). Every adapter also has its own HTTP conformance suite (`fetch` against
  a live server, one assertion per response shape). If the official SDK is happy, the wire format is
  correct — across all four adapters.
- **Drop-in migration** — `examples/migrated-langgraph` runs a real `langgraph.json` under `skein dev`
  in place of `langgraph dev`, with **no other change** — the headline compatibility test.
- **React `useStream` (frontend)** — `examples/react-usestream` streams a reply token-by-token from
  skein-js, pointed at the `examples/gemini-chat` Gemini backend for a live model-backed FE+BE run.
- **Agent Chat UI interop** — the stock Agent Chat UI points at a local skein-js server and renders a
  streamed conversation.
- **Browser e2e (flagship)** — `examples/chat-app` is driven by **Playwright** end to end, asserting
  streamed tokens, a rendered **thinking block**, and a **tool-call card** (model-key-gated).
- **Long-term memory** — a run-engine test writes and reads via the injected `getStore()`, and
  `chat-app` recalls a saved fact across threads.
- **Postgres + Redis (Testcontainers)** — the conformance suite re-runs against real Postgres, and a
  **cross-instance** test starts a run on instance A and joins its SSE stream from instance B via Redis.

Run them with `pnpm test` (fast unit + conformance, no Docker) and `pnpm test:integration`
(Testcontainers — needs Docker). See the full [verification matrix](./docs/roadmap.md#verification).

## Documentation

Full design and how-to guides live in [`docs/`](./docs):

- [Overview & vision](./docs/index.md)
- [LangGraph CLI compatibility](./docs/langgraph-cli-compat.md) — commands + the `langgraph.json` fields
- [Embedding a graph you already have](./docs/embedding.md) — the in-code on-ramp (no `langgraph.json`)
- [Agent Protocol surface](./docs/agent-protocol.md) — the endpoints skein-js serves
- [Building your own adapter](./docs/building-an-adapter.md) — put skein-js on any HTTP framework
- [Streaming (SSE)](./docs/streaming.md) — stream modes, thinking, reconnect/replay
- [React SDK / `useStream`](./docs/react-sdk.md) — building the frontend
- [Storage](./docs/storage.md) — persistence, long-term memory, pgvector
- [Runs & Redis](./docs/runs-and-redis.md) — the run engine and scaling to multiple instances
- [Reuse-first architecture](./docs/reuse.md) — what we reuse vs. rebuild _(design)_
- [Roadmap](./docs/roadmap.md)

## Contributing & feedback

skein-js is young and we'd love your help — especially **LangGraph CLI compatibility reports** (does
your `langgraph dev` project work under `skein dev`?).

- 🐛 **Found a bug or a compatibility gap?** [Open an issue](https://github.com/skein-js/skein-js/issues).
- 💡 **Want a feature or a new framework adapter?** [Start a discussion or file an issue](https://github.com/skein-js/skein-js/issues).
- 🙌 **Want to contribute code?** PRs are very welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) to
  get set up (and [AGENTS.md](./AGENTS.md) for the deep contributor guide).

## License

[Apache-2.0](./LICENSE)
