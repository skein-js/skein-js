# Skein — Overview

Skein is a framework-agnostic TypeScript library that implements LangChain's
[**Agent Protocol**](https://github.com/langchain-ai/agent-protocol) on top of
[**LangGraph.js**](https://github.com/langchain-ai/langgraphjs), and ships a CLI that is a
**drop-in replacement for the LangGraph CLI**.

## The problem

There is no first-class, self-hostable way to serve LangGraph.js graphs behind a standard
API in the Node ecosystem:

- **LangGraph Platform** (LangSmith Deployments) is hosted and closed.
- **[aegra](https://github.com/aegra/aegra)** — the leading open self-hosted alternative — is
  Python/FastAPI only.

TypeScript teams are left to adopt the hosted platform, run a Python sidecar, or hand-roll
an HTTP layer around a compiled graph.

## The solution

Skein is "aegra for TypeScript." It exposes the Agent Protocol wire format from any Node
HTTP framework (Express first; Fastify and NestJS to follow), so the whole LangChain client
surface keeps working with only a URL change.

## The drop-in promise

The headline developer experience is **zero-effort migration off the LangGraph CLI**:

```diff
- "dev": "langgraph dev",
+ "dev": "skein dev",
```

…while keeping the existing [`langgraph.json`](./langgraph-cli-compat.md) unchanged. Both
the backend (config + graphs) and the frontend ([`useStream`](./react-sdk.md)) point at
Skein by changing only a URL.

## Architecture at a glance

```
             ┌─────────────────────────────────────────────┐
   clients   │  @langchain/langgraph-sdk · /react useStream │
 (unchanged) │  Agent Chat UI · LangGraph Studio            │
             └──────────────────────┬──────────────────────┘
                                    │ Agent Protocol (HTTP + SSE)
             ┌──────────────────────▼──────────────────────┐
  adapters   │   @skein/express  (· fastify · nestjs)       │
             ├─────────────────────────────────────────────┤
   core      │   @skein/core  — router · run engine ·       │
             │   streaming · auth                           │
             ├───────────────┬───────────────┬─────────────┤
             │  @skein/config│ storage driver│  @skein/redis│
             │ (langgraph.   │ memory /      │ queue + pub/ │
             │  json loader) │ postgres+pgv  │ sub          │
             └───────────────┴───────────────┴─────────────┘
                                    │
                          LangGraph.js compiled graphs
```

- **`@skein/core`** holds the protocol logic once, against *normalized* request/response
  types. Framework adapters are thin shims. See each doc below for detail.

## Documentation map

| Doc | Covers |
| --- | --- |
| [agent-protocol.md](./agent-protocol.md) | The REST + streaming endpoints Skein implements |
| [langgraph-cli-compat.md](./langgraph-cli-compat.md) | `langgraph.json` fields + CLI commands |
| [streaming.md](./streaming.md) | LangGraph stream modes → Agent Protocol SSE |
| [react-sdk.md](./react-sdk.md) | `@langchain/langgraph-sdk` + `useStream` compatibility |
| [storage.md](./storage.md) | `SkeinStore`, in-memory + Postgres, pgvector, checkpointer |
| [runs-and-redis.md](./runs-and-redis.md) | Run engine, queue, cross-instance streaming |
| [roadmap.md](./roadmap.md) | Milestones and post-MVP non-goals |

## References

- Agent Protocol — <https://github.com/langchain-ai/agent-protocol>
- LangGraph.js — <https://github.com/langchain-ai/langgraphjs>
- LangGraph docs — <https://docs.langchain.com>
- aegra (Python prior art) — <https://github.com/aegra/aegra> · <https://www.aegra.dev>
