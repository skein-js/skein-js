# Roadmap

What works today, what's coming, and what deliberately isn't. For _when_ something landed, see the
[changelog](https://github.com/skein-js/skein-js/blob/main/CHANGELOG.md); hit a gap, or one not
listed here? [File an issue](https://github.com/skein-js/skein-js/issues) — compatibility reports are
the most useful feedback we get.

## What's supported

Measured against the LangGraph CLI and LangGraph Platform, since skein-js is a drop-in for the first
and an open alternative to the second.

**CLI and runtimes**

| Capability                                   | Status     | Notes                                                                                         |
| -------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `dev` / `up` / `build` / `dockerfile`        | ✅         | Drop-in, plus skein-only `start` and `import-langgraph`. [Details](./langgraph-cli-compat.md) |
| Project scaffolding                          | ✅         | `npm create skein-js@latest` — no LangGraph Platform equivalent. [Details](./scaffolding.md)  |
| Node 24 production runtime                   | ✅         | Default production image and fallback                                                         |
| Bun / Deno production runtimes               | ⚠️ preview | Fetch launchers and images ship; clean-artifact matrices must graduate each                   |
| Express · Fastify · NestJS · Next.js · Fetch | ✅         | Standalone or embedded in an app you already run. [Details](./using-skein.md)                 |
| Embed a graph in code, no CLI                | ✅         | [Details](./embedding.md)                                                                     |
| A graph as a plain endpoint                  | ✅         | `POST /invoke/:graph_id`. [Details](./serving-a-single-graph.md)                              |

**Protocol surface**

| Capability                                 | Status | Notes                                                                                                                        |
| ------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Assistants / threads / runs / store        | ✅     | Routes _and_ request bodies, guarded against SDK drift                                                                       |
| Assistants CRUD + versioning               | ✅     | Version history and rollback; graph/subgraph introspection. [Details](./assistants.md)                                       |
| Streaming, incl. true `events` mode        | ✅     | Real `streamEvents` v2. [Details](./streaming.md)                                                                            |
| Human-in-the-loop (interrupt / resume)     | ✅     | Via LangGraph checkpointers. [Details](./human-in-the-loop.md)                                                               |
| Time travel — fork from a checkpoint       | ✅     | Read, update and run from any prior checkpoint. [Details](./threads.md)                                                      |
| Multitask / double-texting                 | ✅     | All four strategies, correct across instances. [Details](./runs.md)                                                          |
| Stateless + batch runs, thread count/prune | ✅     | `POST /runs`, `/runs/batch`, `/runs/cancel`                                                                                  |
| Auth + authorization                       | ✅     | LangGraph `Auth` parity, ownership filters in the driver query. [Details](./agent-protocol.md#authentication--authorization) |
| Run-completion webhooks                    | ✅     | **Durable, signed, retried, replayable.** No LangGraph Platform equivalent. [Details](./webhooks.md)                         |
| `http.disable_*` flags · `GET /info`       | ✅     | `/ok` stays outside the table, so no flag can break the probe                                                                |
| **Idempotent run creation**                | ✅     | **No LangGraph Platform equivalent.** [Details](./agent-protocol.md#idempotent-run-creation-idempotency-key)                 |
| MCP endpoint (`/mcp`)                      | 🗺️     | LangGraph exposes graphs as MCP tools; not yet built                                                                         |
| Generative UI (`/ui/{agent}`)              | 🗺️     | Needs a `ui` config block, a bundler and asset serving                                                                       |
| `/docs` OpenAPI page                       | 🗺️     | LangGraph serves one; `skein dev` links the published docs instead                                                           |

**Storage, scale and operations**

| Capability                               | Status | Notes                                                                                                                    |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| In-memory (dev) · Postgres + pgvector    | ✅     | [Details](./storage.md)                                                                                                  |
| Bring your own store (`store.adapter`)   | ✅     | [Details](./storage.md#bringing-your-own-store-storeadapter)                                                             |
| Store TTL · filter · namespace traversal | ✅     | [Details](./storage.md#filtering-and-namespace-traversal)                                                                |
| Thread TTL                               | ✅     | Past LangGraph OSS, which drops `ttl` on the floor                                                                       |
| Multi-instance                           | ✅     | Atomic create guard, cross-instance cancel, per-thread execution claim. [Details](./deploy.md#scaling-past-one-instance) |
| Cron / scheduled runs                    | ✅     | Full Crons resource + scheduler, every driver. [Details](./crons.md)                                                     |
| Observability                            | ✅     | LangSmith, PostHog, OpenTelemetry. [Details](./observability.md)                                                         |
| **Console / Studio equivalent**          | ✅     | Self-hosted at `/console` — no account, no tunnel. [Details](./console.md)                                               |

## Planned

- 🗺️ **Inbound events — agents behind WhatsApp, Slack and anything else.** The big one: a pipeline
  plus an `EventSource` plugin interface, so putting an agent behind a provider is one small file
  instead of six pieces of plumbing everyone re-solves. Generic over events, so a GitHub webhook fits
  the same interface. [Design](./proposals/inbound-events.md).

- 🗺️ **MCP endpoint**, **generative UI**, **`/docs` OpenAPI page** — the LangGraph parity backlog
  above, in priority order.
- 🗺️ **Per-thread partitioned dispatch.** A run waiting on a busy thread's execution claim still
  holds a worker slot. Purely about utilization — the claim already makes ordering safe.
- 🗺️ **`POST /runs/search`** — cross-thread run search; today runs list per thread.

## Non-goals

- ❌ **WebSocket transport.** SSE covers the client UX and doesn't affect the React SDK.
- ❌ **`skein deploy` to a hosted platform.** Self-hosted by design; there's no managed target.
- ❌ **Sub-minute cron schedules.** A 5-field expression can't express them, and accepting a 6-field
  one would run a schedule at a different time than its author's crontab says.
- ❌ **Backfilling missed cron occurrences.** A cron due during an outage fires once on return and
  resyncs rather than replaying the backlog. [Details](./crons.md#semantics).
