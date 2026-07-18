# Roadmap

> Project milestones and post-MVP non-goals — fine for anyone to read. For the product overview see the
> [README](../README.md) and [docs index](./index.md).

## Contents

- [Phase 0 — Documentation & scaffolding](#phase-0--documentation--scaffolding--current)
- [Phase 1+ — Implementation](#phase-1--implementation)
  - [Done](#done-)
  - [Remaining (MVP)](#remaining-mvp)
- [Shipped beyond the original plan](#shipped-beyond-the-original-plan)
- [Planned / coming soon (post-MVP)](#planned--coming-soon-post-mvp)
- [Known gaps vs. the LangGraph CLI / Platform](#known-gaps-vs-the-langgraph-cli--platform)
- [Non-goals for v1](#non-goals-for-v1)
- [Verification](#verification)

## Phase 0 — Documentation & scaffolding ✅ (current)

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

Steps 1–10 below are complete: the dev loop **and** self-hosted production both work end to end.

1. ✅ **Scaffold core** — `@skein-js/core` skeleton with tsup build + vitest.
2. ✅ **Types + `@skein-js/config`** — reuse `@langchain/langgraph-sdk` types + `@langchain/langgraph-api`
   schemas for the wire contract (don't hand-roll); define `SkeinStore` + queue/pub-sub
   interfaces; build `@skein-js/config` on `@langchain/langgraph-api`'s `./schema` parser for
   `langgraph.json` loading (`path:export`, factory) early — everything downstream consumes it.
3. ✅ **Storage-memory + in-memory queue** — implement `SkeinStore` in-memory; conformance tests.
4. ✅ **Core handlers + run engine** — assistants introspection, threads CRUD, the three run
   modes, store CRUD; wire LangGraph `invoke`/`stream` + interrupt/resume; SSE mapping incl.
   thread-scoped streaming + commands. The long-term store is injected into graph runs as a
   LangGraph `BaseStore` (`getStore()`), matching LangGraph Platform — see [storage.md](./storage.md#long-term-memory-in-the-graph-getstore).
5. ✅ **`@skein-js/express`** — mount the handler table on an Express `Router`; SSE piping.
6. ✅ **`skein` CLI — `dev`** — boots the Express server from `langgraph.json` in-process with
   hot reload, no Docker. The drop-in moment.
7. ✅ **End-to-end / conformance** — drive with `@langchain/langgraph-sdk`; Agent Chat UI connects.
   The model-backed FE/BE signal is `examples/gemini-chat` (a Gemini ReAct agent served by
   `skein dev`) streamed into `examples/react-usestream` via `useStream`; `examples/chat-app` extends
   this to a full research assistant (thinking + web search + memory) with a shadcn UI.
8. ✅ **`@skein-js/redis`** — Redis queue + worker + cross-instance pub/sub streaming.
9. ✅ **Storage-postgres + pgvector** — `SkeinStore` over `pg` + `PostgresSaver`; semantic
   store search; migrations.
10. ✅ **CLI — `up` / `build` / `dockerfile`** — Docker Compose (Postgres + Redis); image build.
    A [`@skein-js/runtime`](../packages/runtime) package assembles the production `ProtocolDeps`
    (Postgres store + `PostgresSaver` + Redis queue/bus) behind the existing `{ deps }` seam, so both
    `skein dev` and the Docker image boot the same engine. `skein dockerfile`/`build` generate a
    Dockerfile from `langgraph.json`; `skein up` brings up app + `pgvector/pgvector` Postgres + Redis
    via Docker Compose.
    - **Pre-built production image (issue #2).** `skein build`/`up` no longer ship a `skein dev`-shaped
      image. They bundle graphs (+ auth/embed) to plain JS on the host with `vite.build()` — the same
      tsconfig-`paths`/workspace-alias resolution as `skein dev`, anchored at the workspace root — into
      a self-contained `.skein/build` artifact (bundled JS + a production `langgraph.json` + a
      precomputed `schemas.json` + a pinned `package.json`). The slim image installs prod deps only and
      runs the artifact via a new **`skein start`** command (native `import()`, no vite, no reload). This
      fixes monorepo builds (aliased `libs/**` are inlined at build time, sidestepping the docker
      build-context gap), cuts cold-start (no runtime TS transform, graphs warmed at boot), and shrinks
      the image (no dev toolchain). `vite` is now an `optionalDependency`, lazy-imported for `dev`/`build`
      only — it never loads in the image.
    - **`skein dev` now optionally uses the production drivers** via `--store postgres` / `--queue redis`
      (connection URLs from `POSTGRES_URI` / `REDIS_URI`), instead of always the in-memory drivers.
      This is a capability `langgraph dev` does **not** offer — it lets you develop and test against
      production-shaped storage (durable checkpoints, cross-instance streaming, pgvector search)
      without `skein up`/full Docker. Graph hot-reload still works; the `.skein/` snapshot is skipped
      because durable stores persist inherently.

### Remaining (MVP)

11. ✅ **Fastify + NestJS + Next.js adapters** — **shipped.** Each is a thin transport shim over the
    same core handler table + shared `skeinRoutes` (now in `@skein-js/agent-protocol`); the
    framework-agnostic in-memory runtime / dev-state import / CORS mapping live in the new
    `@skein-js/server-kit` so no adapter depends on another. Standalone servers
    (`createFastifyServer` / `createNestServer` / `createSkeinRouteHandlers`) and embedded modes
    (`skeinPlugin`, `SkeinModule.forRoot`, App/Pages Router route handlers) each ship a runnable
    example. **The MVP adapter set is complete.**

## Shipped beyond the original plan

- ✅ **In-code embedding on-ramp** — a second way in for LangGraph.js users who never adopted the
  Platform's project shape: bring a compiled graph (or a map of them) in code and get the full Agent
  Protocol server with **no `langgraph.json` and no CLI**. `createInMemoryDeps(graphs, overrides?)` and
  `graphMapToResolver(graphs)` in [`@skein-js/server-kit`](../packages/server-kit) turn a graph map into
  a `ProtocolDeps` backed by in-memory drivers, handed to any adapter's existing `{ deps }` seam;
  `overrides` swaps in Postgres/Redis for production. The engine was already runtime-config-decoupled
  (it consumes an injectable `GraphResolver`, not a config file) — this exposes that path publicly and
  documents it. See [embedding.md](./embedding.md) and [`examples/embed-graph`](../examples/embed-graph).
  The one trade-off vs the config path: schemas are stubbed (a compiled graph carries no source to
  extract them from), which only affects LangGraph Studio, not `useStream` / Agent Chat UI.
- ✅ **Authentication + authorization (LangGraph parity)** — custom auth via a `langgraph.json`
  `auth` block that loads a `@langchain/langgraph-sdk/auth` `Auth` instance. Transport-neutral (in
  [`@skein-js/agent-protocol`](../packages/agent-protocol), so every adapter inherits it): each
  request is authenticated (`401`) and authorized per resource + action (`403`), with `@auth.on.*`
  ownership filters scoping reads (non-owned → `404`) and stamping writes. Honors
  `disable_studio_auth`. Reuses the SDK's `Auth` contract + langgraph-api's `isAuthMatching`; only
  the instance-scoped dispatch is reimplemented (langgraph-api's `registerAuth` is module-global).
  See [agent-protocol.md](./agent-protocol.md#authentication--authorization). **Follow-up (scale):**
  push ownership filters into SQL on the Postgres driver (today filtering is in-process after a
  fetch — correct at any size, but lists all rows first); per-owner scoping of `assistants` and
  `store` (both gate-only today — assistants are auto-registered without an owner and store rows
  carry no metadata).
- ✅ **Assistants CRUD + versioning (LangGraph parity)** — beyond the auto-registered one-per-graph
  assistant, the full `@langchain/langgraph-sdk` surface: `POST/PATCH/DELETE /assistants` (with
  `if_exists` and `?delete_threads`), enhanced `search` (name/metadata/sort) + `count`, a **version
  history** (`POST .../versions`) you can roll back to (`POST .../latest`), and graph/subgraph
  introspection (`GET .../graph`, `.../subgraphs`). Each `PATCH` mints an immutable version; the live
  row tracks the active one, so runs and history are unchanged. Versioning lives in `SkeinStore`'s
  `AssistantRepo` (both drivers, one conformance suite; Postgres migration `0003`). See
  [storage.md](./storage.md#assistant-versioning) and
  [agent-protocol.md](./agent-protocol.md#assistants).
- ✅ **Multitask / double-texting strategies (LangGraph parity)** — a second message arriving mid-run
  is handled by all four `multitask_strategy` values: `reject` (busy thread → `422`, matching
  langgraph-api), `enqueue` (the new run waits behind the active one), `interrupt` (stop the active
  run keeping its work, then start), and `rollback` (stop the active run, discard its checkpoint
  writes, then start). Lives in [`@skein-js/agent-protocol`](../packages/agent-protocol)'s run engine:
  a per-thread execution lock serializes runs (enqueue), and rollback reverts the thread to the
  displaced run's base checkpoint via the `BaseCheckpointSaver`. Fully correct in a single process
  (the `langgraph dev` bar); cross-instance coordination is the same open Redis item as the existing
  concurrency guard.
- ✅ **Run-completion webhooks (LangGraph parity)** — a `webhook` URL on run creation is carried
  through (and preserved by `import-langgraph`) and POSTed the settled run once it reaches a terminal
  status, with LangGraph's payload shape (the run plus `status`, `run_started_at`/`run_ended_at`/
  `webhook_sent_at`, final `values`, and an `error` on failure). Fired from the run engine's terminal
  step (so every run mode delivers), best-effort via an injectable dispatcher (a delivery failure
  never fails the run). The default dispatcher restricts the scheme to `http(s)`; because `webhook` is
  a client-supplied URL the server POSTs to (an SSRF surface carrying the run's `values`), deployments
  that accept untrusted clients should inject a `webhookDispatcher` that allowlists the target host —
  the default stays permissive since internal webhook targets are legitimate in a self-hosted setup.
- ✅ **True `events` stream mode (LangGraph parity)** — `stream_mode: "events"` now drives the graph
  via LangGraph's `streamEvents` (v2) and streams token/tool/step events at full granularity, instead
  of the old `updates` approximation. Requesting `events` alongside other modes yields both.

## Planned / coming soon (post-MVP)

These are on the map but not yet built. Want one sooner? Upvote or open an issue —
<https://github.com/mainawycliffe/skein-js/issues>.

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

- ✅ **`@skein-js/nextjs` adapter — serve smaller graphs from Next.js API routes.** **Shipped.** Mount
  the Agent Protocol inside an existing Next.js app — a single App Router catch-all
  (`createSkeinRouteHandlers` → Web `Request`/`Response`, SSE as a `ReadableStream`) **or** a Pages
  Router handler (`createSkeinPagesHandler`), same-origin with no separate server process. **Caveat:**
  the background run worker (and the in-memory driver's shared state) need a long-lived Node process —
  fine on `next start` with `runtime = 'nodejs'`, but serverless/edge deploys require the Redis queue
  and Postgres store (steps 8–9). See [`examples/nextjs-app`](../examples/nextjs-app) (App Router +
  `useStream` UI) and [`examples/nextjs-basic`](../examples/nextjs-basic) (Pages Router, headless).
- 🗺️ **Custom-adapter example.** The [Building your own adapter](./building-an-adapter.md) guide
  exists; we still want a runnable `examples/custom-adapter` (a dependency-free Node `http` — or Hono
  — adapter over the transport-neutral handler table) as an executable, tested reference to accompany
  the guide.

## Known gaps vs. the LangGraph CLI / Platform

skein-js aims to be a **drop-in for the LangGraph CLI**, so it's worth being explicit about what
isn't covered yet. If you hit one of these — or a gap not listed here — please
[file an issue](https://github.com/mainawycliffe/skein-js/issues); compatibility reports are the most
valuable feedback we can get.

| Capability                             | Status in skein-js | Notes                                                             |
| -------------------------------------- | ------------------ | ----------------------------------------------------------------- |
| `dev` / `up` / `build` / `dockerfile`  | ✅ shipped         | Drop-in for the LangGraph CLI commands.                           |
| Assistants / threads / runs / store    | ✅ shipped         | Full Agent Protocol surface; three run modes; SSE streaming.      |
| Thread search / copy                   | ✅ shipped         | Metadata/status filter + pagination; copy duplicates history.     |
| Store item TTL                         | ✅ shipped         | `store.ttl` (default/refresh-on-read/sweep) + per-put `ttl`.      |
| Distinct cancelled run status          | ✅ shipped         | Cancel resolves to `cancelled`, not `error`.                      |
| Human-in-the-loop (interrupt/resume)   | ✅ shipped         | Via LangGraph checkpointers.                                      |
| Auth + authorization                   | ✅ shipped         | LangGraph `Auth` parity — see below.                              |
| Multitask / double-texting             | ✅ shipped         | `reject` (422) / `enqueue` / `interrupt` / `rollback`.            |
| **Cron / scheduled runs**              | 🗺️ planned         | LangGraph Platform's Crons resource; not yet implemented.         |
| **Time travel (fork from checkpoint)** | 🗺️ planned         | History is read-only today; fork/update-state planned.            |
| Assistants CRUD + versioning           | ✅ shipped         | Create/update/delete + version history/rollback; graph/subgraphs. |
| **MCP endpoint (`/mcp`)**              | 🗺️ planned         | LangGraph exposes graphs as MCP tools; not yet implemented.       |
| Run-completion webhooks                | ✅ shipped         | `webhook` URL POSTed the settled run on completion.               |
| True `events` stream mode              | ✅ shipped         | Real `streamEvents` (v2); full token/tool/step granularity.       |
| Fastify / NestJS adapters              | ✅ shipped         | Plugin / `SkeinModule`; standalone + embedded examples.           |
| Next.js API-route adapter              | ✅ shipped         | App Router + Pages Router; same-origin, `useStream` UI example.   |
| WebSocket streaming transport          | ❌ non-goal (v1)   | SSE covers the client UX; does not affect the React SDK.          |
| `deploy` to a hosted platform          | ❌ non-goal        | skein-js is self-hosted by design.                                |
| Full OpenTelemetry observability       | ❌ non-goal (v1)   | May revisit post-v1.                                              |

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
