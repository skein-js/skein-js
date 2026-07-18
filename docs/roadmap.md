# Roadmap

> Project milestones and post-MVP non-goals — fine for anyone to read. For the product overview see the
> [README](../README.md) and [docs index](./index.md).

## Contents

- [Phase 0 — Documentation & scaffolding](#phase-0--documentation--scaffolding-)
- [Phase 1+ — Implementation](#phase-1--implementation)
  - [Done](#done-)
- [Planned / coming soon (post-MVP)](#planned--coming-soon-post-mvp)
- [Known gaps vs. the LangGraph CLI / Platform](#known-gaps-vs-the-langgraph-cli--platform)
- [Non-goals for v1](#non-goals-for-v1)
- [Verification](#verification)

## Phase 0 — Documentation & scaffolding ✅

- Repo, license, README, `AGENTS.md`/`CLAUDE.md`, and this `docs/` set (incl.
  [reuse](./reuse.md), [code-practices](./code-practices.md), [testing](./testing.md)).
- Nx workspace + publishable `@skein-js/*` package stubs (each with a README).
- Tooling: ESLint + Prettier, Vitest workspace, `@skein-js/test-support` (Testcontainers +
  `SkeinStore` conformance seed).
- Examples: `express-basic` (zero-setup `echo` + Claude `agent` graphs), `react-usestream` (the
  [`useStream`](./react-sdk.md) harness), `gemini-chat` (model-backed e2e), `migrated-langgraph`
  (the drop-in proof), and `chat-app` (the flagship research assistant + shadcn UI).

## Phase 1+ — Implementation

### Done ✅

Steps 1–11 below are complete: the dev loop, self-hosted production, **and** the full
multi-framework adapter set all work end to end.

1. ✅ **Scaffold core** — `@skein-js/core` skeleton with tsup build + vitest.
2. ✅ **Types + `@skein-js/config`** — reuse `@langchain/langgraph-sdk` types + `@langchain/langgraph-api`
   schemas for the wire contract; define the `SkeinStore` + queue/bus interfaces; `@skein-js/config`
   loads and validates `langgraph.json` (`path:export`, factory).
3. ✅ **Storage-memory + in-memory queue** — implement `SkeinStore` in-memory; conformance tests.
4. ✅ **Core handlers + run engine** — assistants introspection, threads CRUD, the three run modes,
   store CRUD; LangGraph `invoke`/`stream` + interrupt/resume; SSE streaming + commands. The store is
   injected into runs as a LangGraph [`getStore()`](./storage.md#long-term-memory-in-the-graph-getstore) `BaseStore`.
5. ✅ **`@skein-js/express`** — mount the handler table on an Express `Router`; SSE piping.
6. ✅ **`skein` CLI — `dev`** — boots the Express server from `langgraph.json` in-process with
   hot reload, no Docker. The drop-in moment.
7. ✅ **End-to-end / conformance** — driven by the real `@langchain/langgraph-sdk`; Agent Chat UI
   connects. Model-backed signal: `examples/gemini-chat` → `examples/react-usestream` via `useStream`;
   `examples/chat-app` is the full research-assistant flagship.
8. ✅ **`@skein-js/redis`** — Redis queue + worker + cross-instance pub/sub streaming.
9. ✅ **Storage-postgres + pgvector** — `SkeinStore` over `pg` + `PostgresSaver`; semantic
   store search; migrations.
10. ✅ **CLI — `up` / `build` / `dockerfile` / `start`** — [`@skein-js/runtime`](../packages/runtime)
    assembles the production `ProtocolDeps` (Postgres store, `PostgresSaver`, and a Redis queue/bus)
    behind the same `{ deps }` seam, so `skein dev` and the image boot the same engine. `skein build`/`up`
    bundle graphs into a slim, pre-built image run by `skein start` (no runtime TS transform), and
    `skein up` runs app, Postgres, and Redis via Compose. `skein dev` can also point at the production
    drivers (`--store postgres` / `--queue redis`) — something `langgraph dev` can't. See
    [langgraph-cli-compat.md](./langgraph-cli-compat.md).

11. ✅ **Fastify + NestJS + Next.js adapters** — thin transport shims over the shared `skeinRoutes`
    handler table, with the framework-agnostic pieces in [`@skein-js/server-kit`](../packages/server-kit).
    Standalone (`create*Server`) and embedded (`skeinPlugin` / `SkeinModule.forRoot` / route handlers)
    modes, each with a runnable example. The MVP adapter set is complete.

Also shipped, beyond the original MVP plan:

- ✅ **In-code embedding on-ramp** — bring a compiled graph (or map) in code and get the full server
  with **no `langgraph.json` and no CLI**: `embedInMemoryGraphs(graphs, overrides?)` builds an
  in-memory `ProtocolDeps` for any adapter's `{ deps }` seam, and `embedPostgresGraphs(...)` does the
  same backed by durable Postgres + Redis. See [embedding.md](./embedding.md) and
  [`examples/embed-graph`](../examples/embed-graph).
- ✅ **Authentication + authorization (LangGraph parity)** — custom auth via a `langgraph.json` `auth`
  block loading a `@langchain/langgraph-sdk/auth` `Auth` instance; transport-neutral, so every adapter
  inherits it. Per-request authenticate (`401`) + authorize per resource/action (`403`) with ownership
  filters. See [agent-protocol.md](./agent-protocol.md#authentication--authorization). _Follow-up:_
  push ownership filters into SQL, and per-owner scoping for `assistants` / `store`.
- ✅ **Assistants CRUD + versioning (LangGraph parity)** — the full SDK surface beyond the
  auto-registered one-per-graph assistant: `POST/PATCH/DELETE`, `search`/`count`, immutable version
  history with rollback, and graph/subgraph introspection. See
  [storage.md](./storage.md#assistant-versioning) and [agent-protocol.md](./agent-protocol.md#assistants).
- ✅ **Multitask / double-texting (LangGraph parity)** — all four `multitask_strategy` values
  (`reject` → `422`, `enqueue`, `interrupt`, `rollback`) via a per-thread execution lock in the run
  engine. Single-process correct (the `langgraph dev` bar); cross-instance coordination is tracked with
  the concurrency guard.
- ✅ **Run-completion webhooks (LangGraph parity)** — a `webhook` URL on run creation is POSTed the
  settled run at terminal status (LangGraph's payload shape), best-effort so a delivery failure never
  fails the run. Inject a `webhookDispatcher` to allowlist hosts when accepting untrusted clients. See
  [recipes.md](./recipes.md#run-completion-webhooks).
- ✅ **True `events` stream mode (LangGraph parity)** — `stream_mode: "events"` drives the graph via
  LangGraph's `streamEvents` (v2) for full token/tool/step granularity; combinable with other modes.
- ✅ **`skein import-langgraph`** — import an existing LangGraph `.langgraph_api/` dev-state directory
  (threads, runs, assistants, store) into skein, so adopting it off `langgraph dev` carries local state
  over losslessly. See [langgraph-cli-compat.md](./langgraph-cli-compat.md).

## Planned / coming soon (post-MVP)

These are on the map but not yet built. Want one sooner? Upvote or open an issue —
<https://github.com/skein-js/skein-js/issues>.

The next block is the LangGraph feature-parity backlog, listed **in priority order** (highest first):

- 🗺️ **Cron / scheduled runs (LangGraph parity).** LangGraph Platform exposes a **Crons** resource
  (create/list/delete schedules that kick off a run on a thread on a cadence). skein-js does not yet
  implement it — see [Known gaps](#known-gaps-vs-the-langgraph-cli--platform). Planned: a `crons`
  resource in [`@skein-js/agent-protocol`](../packages/agent-protocol) backed by a scheduler over the
  existing run queue (a natural fit for the BullMQ repeatable-jobs feature on the Redis driver).
- 🗺️ **Time travel — fork from a past checkpoint (LangGraph parity).** skein-js reads thread history
  (`/threads/{id}/history`) today, but there is no way to update state at an arbitrary prior checkpoint
  and re-run from there. LangGraph's time-travel lets you branch from any checkpoint to explore
  alternatives. Planned: an update-state-at-checkpoint operation over the LangGraph checkpointer plus a
  fork that starts a new run from the chosen checkpoint. (Thread copy — full-history duplication — ships
  today and is the coarser cousin of this.)
- 🗺️ **MCP endpoint (LangGraph parity).** LangGraph Server exposes graphs as MCP tools at `/mcp`.
  skein-js has no MCP surface yet. Planned: an `/mcp` handler in the transport-neutral handler table
  that advertises each graph as an MCP tool and bridges tool calls onto runs.

The remaining backlog is skein-js's own adapter/tooling roadmap:

- 🗺️ **Custom-adapter example.** The [Building your own adapter](./building-an-adapter.md) guide
  exists; we still want a runnable `examples/custom-adapter` (a dependency-free Node `http` — or Hono
  — adapter over the transport-neutral handler table) as an executable, tested reference to accompany
  the guide.

## Known gaps vs. the LangGraph CLI / Platform

skein-js aims to be a **drop-in for the LangGraph CLI**, so it's worth being explicit about what
isn't covered yet. If you hit one of these — or a gap not listed here — please
[file an issue](https://github.com/skein-js/skein-js/issues); compatibility reports are the most
valuable feedback we can get.

| Capability                             | Status in skein-js | Notes                                                                        |
| -------------------------------------- | ------------------ | ---------------------------------------------------------------------------- |
| `dev` / `up` / `build` / `dockerfile`  | ✅ shipped         | Drop-in for the LangGraph CLI, plus skein-only `start` + `import-langgraph`. |
| Assistants / threads / runs / store    | ✅ shipped         | Full Agent Protocol surface; three run modes; SSE streaming.                 |
| Thread search / copy                   | ✅ shipped         | Metadata/status filter + pagination; copy duplicates history.                |
| Store item TTL                         | ✅ shipped         | `store.ttl` (default/refresh-on-read/sweep) + per-put `ttl`.                 |
| Distinct cancelled run status          | ✅ shipped         | Cancel resolves to `cancelled`, not `error`.                                 |
| Human-in-the-loop (interrupt/resume)   | ✅ shipped         | Via LangGraph checkpointers.                                                 |
| Auth + authorization                   | ✅ shipped         | LangGraph `Auth` parity — see below.                                         |
| Multitask / double-texting             | ✅ shipped         | `reject` (422) / `enqueue` / `interrupt` / `rollback`.                       |
| **Cron / scheduled runs**              | 🗺️ planned         | LangGraph Platform's Crons resource; not yet implemented.                    |
| **Time travel (fork from checkpoint)** | 🗺️ planned         | History is read-only today; fork/update-state planned.                       |
| Assistants CRUD + versioning           | ✅ shipped         | Create/update/delete + version history/rollback; graph/subgraphs.            |
| **MCP endpoint (`/mcp`)**              | 🗺️ planned         | LangGraph exposes graphs as MCP tools; not yet implemented.                  |
| Run-completion webhooks                | ✅ shipped         | `webhook` URL POSTed the settled run on completion.                          |
| True `events` stream mode              | ✅ shipped         | Real `streamEvents` (v2); full token/tool/step granularity.                  |
| Fastify / NestJS adapters              | ✅ shipped         | Plugin / `SkeinModule`; standalone + embedded examples.                      |
| Next.js API-route adapter              | ✅ shipped         | App Router + Pages Router; same-origin, `useStream` UI example.              |
| WebSocket streaming transport          | ❌ non-goal (v1)   | SSE covers the client UX; does not affect the React SDK.                     |
| `deploy` to a hosted platform          | ❌ non-goal        | skein-js is self-hosted by design.                                           |
| Full OpenTelemetry observability       | ❌ non-goal (v1)   | May revisit post-v1.                                                         |

## Non-goals for v1

Deliberately out of scope for the first stable release (may be revisited later):

- **WebSocket streaming transport** — SSE covers the client UX and **does not affect the React SDK**.
- **`skein deploy` to a hosted platform** — skein-js is self-hosted by design; there's no managed
  target to push to.
- **Full OpenTelemetry observability** — structured logging ships today; full OTel tracing is a
  later consideration.

## Verification

| Layer                               | How                                                                                                                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**                            | vitest per package; storage drivers against a shared `SkeinStore` conformance suite; run-engine transitions; SSE frame mapping.                                                          |
| **Conformance / e2e**               | `examples/express-basic` exercised by the real `@langchain/langgraph-sdk` client (`threads.create`, `runs.stream`, `runs.wait`). If the official SDK is happy, the wire format is right. |
| **Drop-in migration (headline)**    | `examples/migrated-langgraph` with a real `langgraph.json` run via `skein dev` in place of `langgraph dev`, no other change.                                                             |
| **React `useStream` (headline FE)** | `examples/react-usestream` streams a reply token-by-token from skein-js — pointed at the `examples/gemini-chat` Gemini backend for a live model-backed FE+BE run.                        |
| **Interop**                         | Agent Chat UI points at the local server; streamed conversation renders.                                                                                                                 |
| **Browser e2e (flagship)**          | `examples/chat-app` — Playwright drives the shadcn UI end to end, asserting streamed tokens, a rendered thinking block, and a tool-call card (key-gated).                                |
| **Long-term memory**                | `@skein-js/agent-protocol` run-engine test: a node writes and reads via the injected `getStore()`; `examples/chat-app` recalls a saved fact across threads.                              |
| **Postgres + Redis**                | Conformance suite re-run against Postgres; cross-instance test — start a run on instance A, join its SSE stream from instance B via Redis.                                               |

See the top-level [plan](../README.md) and each feature doc for detail.
