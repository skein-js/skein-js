# skein-js — Overview

skein-js is a framework-agnostic TypeScript library that implements LangChain's
[**Agent Protocol**](https://github.com/langchain-ai/agent-protocol) on top of
[**LangGraph.js**](https://github.com/langchain-ai/langgraphjs), and ships a CLI that is a
**drop-in replacement for the LangGraph CLI**.

## Contents

- [The problem](#the-problem)
- [What is the Agent Protocol?](#what-is-the-agent-protocol)
- [The solution](#the-solution)
- [The drop-in promise](#the-drop-in-promise)
- [Architecture at a glance](#architecture-at-a-glance)
- [Examples](#examples)
- [Documentation map](#documentation-map)
- [References](#references)

## The problem

You've built an agent as a LangGraph.js graph. On its own, a graph is a function you call
in-process. To put it behind a chat UI or expose it to other services you need a **server** — and a
capable agent server is a lot of plumbing:

- **Threads** — conversations that persist, with full state and history.
- **Runs** — execute the graph and either wait for the result, **stream** it, or run it in the
  background.
- **Streaming** — push tokens, tool calls, and reasoning to the client as they happen, with
  reconnect/replay if a connection drops.
- **Human-in-the-loop** — pause a run for approval and resume it later.
- **Long-term memory** — storage that outlives a single conversation.
- **Auth, CORS, persistence, and scaling** — the production essentials.

There is no first-class, **self-hostable** way to get all of this for LangGraph.js in the Node
ecosystem:

- **LangGraph Platform** (now **LangSmith Deployment**) is a **paid product**. You _can_ self-host
  it, but production self-hosting is an **Enterprise add-on requiring a commercial license key** —
  the platform's server runtime is source-available under the
  [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license), not open source. The
  managed **Plus** plan is **$39 / seat / month** plus usage-based deployment pricing (~$0.005 per
  deployment run and per-minute uptime); fully self-hosted / hybrid is **Enterprise-only** with
  custom pricing. A free **Self-Hosted Lite** exists but is node-capped and still needs a LangSmith
  API key. ([pricing](https://www.langchain.com/pricing) ·
  [self-hosting docs](https://docs.langchain.com/langgraph-platform/self-hosted), as of July 2026.)
- **[aegra](https://github.com/aegra/aegra)** — the leading _open_ self-hosted alternative — is
  **Python / FastAPI only**.

TypeScript teams are left to adopt the paid platform, run a Python sidecar, or hand-roll an HTTP
layer around a compiled graph.

## What is the Agent Protocol?

The [**Agent Protocol**](https://github.com/langchain-ai/agent-protocol) is the open HTTP + SSE
standard that describes an agent server's surface — assistants, threads, runs, streaming,
interrupts, and a store. Because it's a standard, the entire LangChain client ecosystem speaks it:

- [`@langchain/langgraph-sdk`](https://www.npmjs.com/package/@langchain/langgraph-sdk) — the vanilla
  JS client (`client.threads` / `client.runs` / …)
- [`@langchain/langgraph-sdk/react`](https://langchain-ai.github.io/langgraphjs/) — the **`useStream`**
  hook, streaming over SSE
- [Agent Chat UI](https://github.com/langchain-ai/agent-chat-ui) and LangGraph Studio

Implement the Agent Protocol and **all of these clients work with your server** — no custom SDK, no
bespoke wire format. skein-js implements it; your existing clients keep working with only a URL
change. See [agent-protocol.md](./agent-protocol.md) for the exact endpoints.

## The solution

skein-js is "aegra for TypeScript." It exposes the Agent Protocol wire format from any Node
HTTP framework (Express first; Fastify and NestJS to follow), so the whole LangChain client
surface keeps working with only a URL change.

Unlike aegra — which had to reimplement the server in Python because the Python
`langgraph-api` is proprietary — the **JavaScript Agent Protocol server is open source and
MIT** ([`@langchain/langgraph-api`](https://www.npmjs.com/package/@langchain/langgraph-api)).
So skein-js is deliberately thin: it **reuses as much LangGraph OSS as possible** (runtime,
checkpointers, parser, schemas, SDK/types) and rebuilds only the durable-production,
multi-framework, drop-in-CLI layer that OSS lacks. See [reuse.md](./reuse.md).

> **Guiding principles:** [Reuse first](./reuse.md) · [Simple, readable, functional code](./code-practices.md).

## The drop-in promise

The headline developer experience is **zero-effort migration off the LangGraph CLI**:

```diff
- "dev": "langgraph dev",
+ "dev": "skein dev",
```

…while keeping the existing [`langgraph.json`](./langgraph-cli-compat.md) unchanged. Both
the backend (config + graphs) and the frontend ([`useStream`](./react-sdk.md)) point at
skein-js by changing only a URL.

## Architecture at a glance

```text
             ┌─────────────────────────────────────────────┐
   clients   │  @langchain/langgraph-sdk · /react useStream │
 (unchanged) │  Agent Chat UI · LangGraph Studio            │
             └──────────────────────┬──────────────────────┘
                                    │ Agent Protocol (HTTP + SSE)
             ┌──────────────────────▼──────────────────────┐
  adapters   │   @skein-js/express  (· fastify · nestjs)       │
             ├─────────────────────────────────────────────┤
  protocol   │   @skein-js/agent-protocol — handler table ·    │
             │   run engine · streaming (SSE)               │
             ├─────────────────────────────────────────────┤
   contract  │   @skein-js/core — wire types · SkeinStore +    │
             │   queue/bus interfaces · edge error          │
             ├───────────────┬───────────────┬─────────────┤
             │  @skein-js/config│ storage driver│  @skein-js/redis│
             │ (langgraph.   │ memory /      │ queue + pub/ │
             │  json loader) │ postgres+pgv  │ sub          │
             └───────────────┴───────────────┴─────────────┘
                                    │
                          LangGraph.js compiled graphs
```

- **`@skein-js/core`** is the shared contract — wire types plus the `SkeinStore`, queue, and bus
  interfaces every other package depends on.
- **`@skein-js/agent-protocol`** holds the protocol logic once, against _normalized_ request/response
  types, driven entirely by injected dependencies. Framework adapters are thin shims, and the
  package is publishable on its own. See each doc below for detail.

## Examples

Runnable projects under [`examples/`](../examples) — each proves a slice of the promise:

| Example                                                | What it shows                                                                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| [`chat-app`](../examples/chat-app)                     | **Flagship** — Gemini research assistant (thinking + web search + long-term memory) with a Next.js + shadcn/ui UI and full tests |
| [`migrated-langgraph`](../examples/migrated-langgraph) | The drop-in proof — a stock LangGraph project under `skein dev`, hot reload + persistence                                        |
| [`gemini-chat`](../examples/gemini-chat)               | Model-backed end-to-end — a Gemini ReAct agent streamed into a browser                                                           |
| [`express-basic`](../examples/express-basic)           | Zero-setup `echo` + a Claude `agent` graph in one config                                                                         |
| [`react-usestream`](../examples/react-usestream)       | Minimal `useStream` SSE-compatibility harness                                                                                    |

## Documentation map

Start with the user-facing guides; the design docs at the bottom explain how skein-js is built.

| Doc                                                  | Covers                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| [langgraph-cli-compat.md](./langgraph-cli-compat.md) | `langgraph.json` fields + CLI commands                     |
| [agent-protocol.md](./agent-protocol.md)             | The REST + streaming endpoints skein-js implements         |
| [building-an-adapter.md](./building-an-adapter.md)   | How to put skein-js on any HTTP framework (custom adapter) |
| [streaming.md](./streaming.md)                       | LangGraph stream modes → Agent Protocol SSE                |
| [react-sdk.md](./react-sdk.md)                       | `@langchain/langgraph-sdk` + `useStream` compatibility     |
| [storage.md](./storage.md)                           | `SkeinStore`, in-memory + Postgres, pgvector, checkpointer |
| [runs-and-redis.md](./runs-and-redis.md)             | Run engine, queue, cross-instance streaming                |
| [deploy-railway.md](./deploy-railway.md)             | Deploying the image on Railway (or any PaaS)               |
| [reuse.md](./reuse.md)                               | _(design)_ What we reuse from LangGraph OSS vs. rebuild    |
| [code-practices.md](./code-practices.md)             | _(contributor)_ Readability, functional style, conventions |
| [testing.md](./testing.md)                           | _(contributor)_ Unit + Testcontainers + conformance suite  |
| [roadmap.md](./roadmap.md)                           | Milestones and post-MVP non-goals                          |

Want to contribute? See [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md).

## References

- Agent Protocol — <https://github.com/langchain-ai/agent-protocol>
- LangGraph.js — <https://github.com/langchain-ai/langgraphjs>
- LangGraph docs — <https://docs.langchain.com>
- aegra (Python prior art) — <https://github.com/aegra/aegra> · <https://www.aegra.dev>
