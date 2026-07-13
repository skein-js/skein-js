# Roadmap

## Phase 0 — Documentation & scaffolding ✅ (current)

- Repo, license, README, `AGENTS.md`/`CLAUDE.md`, and this `docs/` set (incl.
  [reuse](./reuse.md), [code-practices](./code-practices.md), [testing](./testing.md)).
- Nx workspace + publishable `@skein-js/*` package stubs (each with a README).
- Tooling: ESLint + Prettier, Vitest workspace, `@skein-js/test-support` (Testcontainers +
  `SkeinStore` conformance seed).
- Examples: `express-basic` (zero-setup `echo` graph + Claude `agent` graph in one
  `langgraph.json`, with a passing echo unit test) and `react-usestream` (the
  [`useStream`](./react-sdk.md) harness).

## Phase 1+ — Implementation

Priority order (**bold = MVP**):

1. **Scaffold core** — `@skein-js/core` skeleton with tsup build + vitest.
2. **Types + `@skein-js/config`** — reuse `@langchain/langgraph-sdk` types + `@langchain/langgraph-api`
   schemas for the wire contract (don't hand-roll); define `SkeinStore` + queue/pub-sub
   interfaces; build `@skein-js/config` on `@langchain/langgraph-api`'s `./schema` parser for
   `langgraph.json` loading (`path:export`, factory) early — everything downstream consumes it.
3. **Storage-memory + in-memory queue** — implement `SkeinStore` in-memory; conformance tests.
4. **Core handlers + run engine** — assistants introspection, threads CRUD, the three run
   modes, store CRUD; wire LangGraph `invoke`/`stream` + interrupt/resume; SSE mapping incl.
   thread-scoped streaming + commands.
5. **`@skein-js/express`** — mount the handler table on an Express `Router`; SSE piping.
6. **`skein` CLI — `dev`** — boots the Express server from `langgraph.json` in-process with
   hot reload, no Docker. The drop-in moment.
7. **End-to-end / conformance** — drive with `@langchain/langgraph-sdk`; Agent Chat UI connects.
8. **`@skein-js/redis`** — Redis queue + worker + cross-instance pub/sub streaming.
9. **Storage-postgres + pgvector** — `SkeinStore` over `pg` + `PostgresSaver`; semantic
   store search; migrations.
10. **CLI — `up` / `build` / `dockerfile`** — Docker Compose (Postgres + Redis); image build.
11. **Fastify + NestJS adapters** — reuse the same core handler table.

## Post-MVP / non-goals for v1

- WebSocket streaming transport (SSE covers the client UX; **does not affect the React SDK**).
- Cron / scheduling.
- `skein deploy` to a hosted platform.
- Full OpenTelemetry observability.

## Verification

| Layer                               | How                                                                                                                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**                            | vitest per package; storage drivers against a shared `SkeinStore` conformance suite; run-engine transitions; SSE frame mapping.                                                          |
| **Conformance / e2e**               | `examples/express-basic` exercised by the real `@langchain/langgraph-sdk` client (`threads.create`, `runs.stream`, `runs.wait`). If the official SDK is happy, the wire format is right. |
| **Drop-in migration (headline)**    | `examples/migrated-langgraph` with a real `langgraph.json` run via `skein dev` in place of `langgraph dev`, no other change.                                                             |
| **React `useStream` (headline FE)** | `examples/react-usestream` streams a reply token-by-token from skein-js.                                                                                                                 |
| **Interop**                         | Agent Chat UI points at the local server; streamed conversation renders.                                                                                                                 |
| **Postgres + Redis**                | Conformance suite re-run against Postgres; cross-instance test — start a run on instance A, join its SSE stream from instance B via Redis.                                               |

See the top-level [plan](../README.md) and each feature doc for detail.
