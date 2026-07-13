# skein-js

> The skein-js CLI — a drop-in replacement for the LangGraph CLI (dev/up/build/dockerfile).

Part of **[skein-js](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — not yet implemented (Phase 1).

## Why skein-js

I wanted to self-host my LangGraph.js graphs behind the standard Agent Protocol — on my own infrastructure, without paying for a license to do it. That turns out to be the catch: the LangGraph Platform server that serves your graphs in production (`langgraph-api`) is under the **Elastic License 2.0**, and self-hosting it requires a paid **enterprise license key** (`LANGGRAPH_CLOUD_LICENSE_KEY`) — without one, the server won't start. So your options today are the hosted platform, or an enterprise contract to run it yourself.

skein-js is the third option. It's **Apache-2.0**, built only on the **MIT-licensed** `@langchain/*` packages, so you can self-host your graphs with **no license key and no per-deployment fee**.

None of this is a knock on LangGraph — skein-js exists _because_ of it. The agent runtime, checkpointers, SDK, and even the MIT JavaScript dev server (`@langchain/langgraph-api`, whose `langgraph.json` parser and schemas skein-js reuses) are all open source, and skein-js doesn't reinvent any of them — it stands on them. A commercially-licensed production server is a fair way for LangChain to fund that open work. skein-js simply fills the one gap that leaves for TypeScript teams: an open, self-hostable way to serve those graphs in production.

**Why not just the LangGraph CLI?** `skein` reads your existing `langgraph.json` and mirrors `dev`/`up`/`build`/`dockerfile`, so the swap is one word. What differs is what happens when you go to production and self-host:

|                            | `langgraph` CLI                                          | `skein` CLI                                     |
| -------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| Local `dev`                | free in-memory dev server (Hono)                         | free in-process dev server, hot reload          |
| Self-hosting in production | requires an enterprise license key (Elastic License 2.0) | Apache-2.0, **no license key**                  |
| Production path            | LangGraph Platform (hosted, or licensed self-host)       | self-hosted Docker Compose you own (`skein up`) |
| Persistence                | platform-managed                                         | your Postgres (+ pgvector) and Redis            |
| HTTP framework             | Hono                                                     | Express (Fastify / NestJS to follow)            |

### When the LangGraph Platform is the better call

skein-js isn't strictly better — it's a different trade, and it's worth being clear about what the Enterprise plan actually buys. It isn't hosting: even on LangGraph's self-hosted tier you still run your own Postgres, Redis, and infrastructure. What you're paying for is **LangChain's support** — dedicated support, response-time SLAs, and architectural guidance from the team that builds LangGraph — plus enterprise features like SSO, RBAC, and SOC2. If you're an established product with real revenue and you want a vendor standing behind your agent stack, that's genuine value, and the Platform is a sound choice.

skein-js gives you the code and full ownership — not a support contract. **It's for you if** you're earlier-stage or cost-sensitive, don't need (or don't want to buy) an enterprise support relationship, want to keep data in your own infrastructure, run a TypeScript/Node stack, or just want to own your agent infrastructure end to end with no license and no vendor lock-in.

The graph code and `langgraph.json` stay unchanged — see the full [Why skein-js comparison](../../README.md#why-skein-js) and the [reuse-first architecture](../../docs/reuse.md).

## What it does

`skein dev` (in-process, hot reload, no Docker), `skein up` (Docker Compose: app + Postgres + Redis), `skein build` / `skein dockerfile`. The one-word swap from `langgraph dev` → `skein dev`.

## Reuse

Mirrors `@langchain/langgraph-cli` semantics and reads an unchanged `langgraph.json`. Reuses `@skein-js/config` (built on `@langchain/langgraph-api`'s parser) for graph loading.

## Install

```bash
pnpm add skein-js
```

## Usage

```ts
# swap in package.json scripts:
#   "dev": "skein dev"
#   "up":  "skein up"
npx skein dev --port 2024
```

## Learn more

- [skein-js overview](../../docs/index.md)
- [Reuse-first architecture](../../docs/reuse.md)
- [Roadmap](../../docs/roadmap.md)

## License

[Apache-2.0](../../LICENSE)
