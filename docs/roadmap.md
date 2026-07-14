# Roadmap

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
    - **`skein dev` now optionally uses the production drivers** via `--store postgres` / `--queue redis`
      (connection URLs from `DATABASE_URL` / `REDIS_URL`), instead of always the in-memory drivers.
      This is a capability `langgraph dev` does **not** offer — it lets you develop and test against
      production-shaped storage (durable checkpoints, cross-instance streaming, pgvector search)
      without `skein up`/full Docker. Graph hot-reload still works; the `.skein/` snapshot is skipped
      because durable stores persist inherently.

### Remaining (MVP)

11. **Fastify + NestJS adapters** — reuse the same core handler table (Express ships today). This is
    the one open MVP item.

## Post-MVP / non-goals for v1

- WebSocket streaming transport (SSE covers the client UX; **does not affect the React SDK**).
- Cron / scheduling.
- `skein deploy` to a hosted platform.
- Full OpenTelemetry observability.
- **`@skein-js/nextjs` adapter** — mount the Agent Protocol inside an existing Next.js app via a
  single App Router catch-all route. The transport-neutral handler table already fits: `ProtocolRequest`
  is a plain `{ params, query, body, headers }` and the SSE `ProtocolResponse` is an
  `AsyncIterable<string>` that maps directly onto a Web `ReadableStream`, so it's a thin adapter like
  Express. **Caveat:** the background run worker (and the in-memory driver's shared state) need a
  long-lived Node process — fine on `next start`, but serverless/edge deploys require the Redis queue
  and Postgres store (steps 8–9) with `runtime = 'nodejs'`. Complementary to `skein dev` (which is the
  standalone dev server), not a replacement.

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
