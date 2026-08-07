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
  filters, pushed into the driver query rather than applied to a full read. See
  [agent-protocol.md](./agent-protocol.md#authentication--authorization). _Follow-up:_ per-owner scoping
  for `assistants` / `store`.
- ✅ **Assistants CRUD + versioning (LangGraph parity)** — the full SDK surface beyond the
  auto-registered one-per-graph assistant: `POST/PATCH/DELETE`, `search`/`count`, immutable version
  history with rollback, and graph/subgraph introspection. See
  [storage.md](./storage.md#assistant-versioning) and [agent-protocol.md](./agent-protocol.md#assistants).
- ✅ **Multitask / double-texting (LangGraph parity)** — all four `multitask_strategy` values
  (`reject` → `422`, `enqueue`, `interrupt`, `rollback`) via a per-thread execution lock in the run
  engine — and now correct **across instances** too (see the multi-instance entry below).
- ✅ **Run-completion webhooks (LangGraph parity)** — a `webhook` URL on run creation is POSTed the
  settled run at terminal status (LangGraph's payload shape), best-effort so a delivery failure never
  fails the run. Inject a `webhookDispatcher` to allowlist hosts when accepting untrusted clients. See
  [recipes.md](./recipes.md#run-completion-webhooks).
- ✅ **True `events` stream mode (LangGraph parity)** — `stream_mode: "events"` drives the graph via
  LangGraph's `streamEvents` (v2) for full token/tool/step granularity; combinable with other modes.
- ✅ **Time travel — fork from a past checkpoint (LangGraph parity)** — update state at an arbitrary
  prior checkpoint (`POST /threads/{id}/state`, writing a new forked checkpoint via `graph.updateState`),
  read state at a specific checkpoint (`GET /threads/{id}/state/{checkpoint_id}`), and start a run that
  forks from a chosen checkpoint (a top-level `checkpoint_id` on run creation) instead of the thread tip.
  Rides the LangGraph checkpointer — no new storage. The fork target is server-validated and injected
  server-side, so a client can't redirect a run to an arbitrary checkpoint through config. See
  [agent-protocol.md](./agent-protocol.md).
- ✅ **Observability — tracing + metrics** — an injectable `TelemetrySink` on `ProtocolDeps`, driven
  from the one run-execution path, with three adapters: [`@skein-js/langsmith`](../packages/telemetry-langsmith)
  (run identity + LangSmith Threads grouping), [`@skein-js/posthog`](../packages/telemetry-posthog)
  (run lifecycle + `$ai_generation` LLM analytics), and [`@skein-js/otel`](../packages/telemetry-otel)
  (spans + metrics against the OTel **API only**, so Datadog/Grafana/Honeycomb/Jaeger/Sentry work
  unchanged). Configured in code, via a `langgraph.json` `telemetry` block, or auto-detected from the
  environment; off by default and free when off, and a sink can never fail or slow a run. See
  [observability.md](./observability.md).
- ✅ **`skein import-langgraph`** — import an existing LangGraph `.langgraph_api/` dev-state directory
  (threads, runs, assistants, store) into skein, so adopting it off `langgraph dev` carries local state
  over losslessly. See [langgraph-cli-compat.md](./langgraph-cli-compat.md).

- ✅ **The rest of the SDK's runs + threads surface** — `POST /runs` (stateless background),
  `POST /runs/batch`, `POST /runs/cancel` (`cancelMany`, including a whole-server sweep),
  `POST /threads/count`, and `POST /threads/prune` (`delete` and `keep_latest`). Plus the small parity
  items around them: `?action=rollback` / `?wait` honoured on cancel, `?status` honoured on
  `GET /threads/{id}/runs`, `on_completion` on stateless runs (defaulting to `keep`, unlike LangGraph —
  see [agent-protocol.md](./agent-protocol.md)), a `GET /info` capability handshake, and a
  **`Content-Location`** header on every run-create response, which is what makes the SDK's
  `onRunCreated` — and therefore `useStream`'s `reconnectOnMount` — work at all.
- ✅ **`http.disable_*` route flags** — `disable_assistants`/`threads`/`runs`/`store`/`meta` filter the
  shared route table before it is mounted, so a disabled resource 404s from the host app exactly as
  under `langgraph dev`. `/ok` is served outside the table, so no config flag can break the container
  health probe.
- ✅ **The last four SDK-reachable routes** — found by diffing the route table against the installed
  `@langchain/langgraph-sdk` and `@langchain/langgraph-api` rather than against the docs:
  `GET /threads/{id}/runs/{run_id}/join` (`client.runs.join()` — blocks, then answers final state as
  JSON), `POST /threads/{id}/state/checkpoint` (`threads.getState()` with an **object** checkpoint,
  which the SDK routes by argument type), `/threads/{id}/stream/events` (the v2 stream transport's
  default path, alongside the `/stream` spelling `joinStream()` uses), and `GET /threads/{id}/history`
  (LangGraph serves history on both verbs). Each rides services that already existed. Also: SSE
  streams now emit `: heartbeat` comments in idle gaps, so a long first-token wait survives a proxy's
  idle timeout and the SDK's `stream_idle_reconnect` has something to read.
- ✅ **SDK request-body parity** — the same diff as the route-table entry above, one level **down**: the
  route table was complete while the _bodies_ were not. Because every body schema is `.passthrough()`,
  a field the SDK sent and skein never read validated, reached the service, and was dropped in silence.
  `if_exists` on `POST /threads` was the sharp end — it clobbered a thread's state on the memory driver
  and escaped as a 500 on Postgres — and is now enforced atomically in both drivers and pinned by the
  conformance suite. Also honoured: `if_not_exists` (which made the three thread-scoped run-create
  routes agree on what an unknown thread means), `after_seconds` (a queue-level delay, so it costs
  nothing while it waits), `on_disconnect` (which `useStream` sends on **every** submit, so
  cancel-on-tab-close had never worked), and `supersteps` on thread create. A workspace-level guard in
  `@skein-js/test-support` now diffs both sides, so the next divergence fails CI instead of shipping.
  See [agent-protocol.md](./agent-protocol.md).
- ✅ **Thread TTL** — `checkpointer.ttl` (LangGraph Platform's `langgraph.json` shape) expires threads
  on a background sweep, with a per-thread `ttl` override and `null` to pin one. Unlike store-item TTL,
  expiry means "may be collected", not "gone", and the sweeper deletes through the thread service so an
  expiring thread's in-flight run is aborted and its checkpoints go with it. Past LangGraph OSS rather
  than catching up to it — `@langchain/langgraph-api` drops `ttl` on the floor. See
  [storage.md](./storage.md).
- ✅ **Multi-instance double-texting** — the four per-process seams are gone: the `reject` guard is an
  atomic check-and-insert in the driver (`RunRepo.createIfThreadIdle`), cancellation crosses instances
  over a `RunAbortChannel` (Redis pub/sub), a run's base checkpoint and rollback plan live on its own
  kwargs so any instance can apply them, and execution is serialized per thread by a
  `ThreadExecutionGate` (a Postgres session advisory lock). See
  [deploy.md](./deploy.md#scaling-past-one-instance).
- ✅ **Cron / scheduled runs** — the full LangGraph Platform **Crons** resource (all seven endpoints,
  stateless and thread-scoped, `enabled` pause/resume, tri-state `end_time`, IANA timezones with DST
  handling) plus the scheduler that fires them. Schedules live in `SkeinStore`, so they survive a
  Redis flush and are searchable and sortable; a compare-and-swap claim makes an occurrence fire
  exactly once across instances with no leader election. The claim and the run row commit together
  as a transactional outbox, and the scheduler's sweep re-enqueues any cron run that was committed
  but never queued — so **cron** delivery is at-least-once. (Ordinary background runs are not swept:
  a bare `pending` run cannot be told apart from an inline `wait`/`stream` run waiting on the thread
  lock, and widening the sweep needs a durable "this run belongs to the queue" marker written at
  create time.) Works on every store/queue combination, including `skein dev` with no Docker. See
  [crons.md](./crons.md).
- ✅ **Idempotent run creation** — an `Idempotency-Key` header on the run creates, so a retry from
  Twilio, Stripe, GitHub or Slack replays the original response instead of starting a second run.
  The claim is an insert arbitrated by the store's uniqueness constraint, so 50 concurrent retries
  across two instances still produce exactly one run; keys are scoped per principal, failures are
  never recorded, and the streaming creates reject the header rather than ignoring it. **LangGraph
  Platform has no equivalent.** Works on every store/queue combination, including `skein dev` with
  no Docker. See
  [agent-protocol.md](./agent-protocol.md#idempotent-run-creation-idempotency-key).

## Planned / coming soon (post-MVP)

These are on the map but not yet built. Want one sooner? Upvote or open an issue —
<https://github.com/skein-js/skein-js/issues>.

The next block is the LangGraph feature-parity backlog, listed **in priority order** (highest first):

- ❌ **Sub-minute schedules** (non-goal). A standard 5-field cron expression cannot express them, and
  accepting a 6-field one would run a schedule at a different time than its author's crontab says.
- ❌ **Backfilling missed cron occurrences** (non-goal). A cron that came due during an outage fires
  once on return and resyncs; it does not replay the backlog. See [crons.md](./crons.md#semantics).
- 🗺️ **MCP endpoint (LangGraph parity).** LangGraph Server exposes graphs as MCP tools at `/mcp`.
  skein-js has no MCP surface yet. Planned: an `/mcp` handler in the transport-neutral handler table
  that advertises each graph as an MCP tool and bridges tool calls onto runs.

The remaining backlog is skein-js's own adapter/tooling roadmap:

- 🗺️ **Per-thread partitioned dispatch.** Background runs are executed up to
  [run concurrency](./runs-and-redis.md#run-concurrency) at a time, and a run waiting on a busy
  thread's execution claim still holds a slot — so a burst of `multitask_strategy: "enqueue"` runs on
  one thread can occupy the worker, and their relative order isn't guaranteed. (LangGraph behaves the
  same way at `N_JOBS_PER_WORKER > 1`.) This is now purely about **worker utilization**, not
  correctness — the execution claim makes the ordering safe either way. The fix is a `partitionKey` on
  `QueuedRun` plus driver-level per-key gating, so the queue never hands out two runs for the same
  thread at once and no slot is spent waiting.

- 🗺️ **Custom-adapter example.** The [Building your own adapter](./building-an-adapter.md) guide
  exists; we still want a runnable `examples/custom-adapter` (a dependency-free Node `http` — or Hono
  — adapter over the transport-neutral handler table) as an executable, tested reference to accompany
  the guide.

## Known gaps vs. the LangGraph CLI / Platform

skein-js is an open alternative to LangGraph Platform and a **drop-in for the LangGraph CLI**, so
it's worth being explicit about what isn't covered yet. If you hit one of these — or a gap not listed here — please
[file an issue](https://github.com/skein-js/skein-js/issues); compatibility reports are the most
valuable feedback we can get.

| Capability                               | Status in skein-js | Notes                                                                                |
| ---------------------------------------- | ------------------ | ------------------------------------------------------------------------------------ |
| `dev` / `up` / `build` / `dockerfile`    | ✅ shipped         | Drop-in for the LangGraph CLI, plus skein-only `start` + `import-langgraph`.         |
| Node 24 production runtime               | ✅ shipped         | Express transport; default production image and fallback.                            |
| Bun / Deno production runtimes           | ⚠️ preview         | Native Fetch launchers/images ship; full clean-artifact matrices must graduate each. |
| Assistants / threads / runs / store      | ✅ shipped         | Full surface — routes _and_ request bodies, guarded against SDK drift.               |
| Thread search / copy                     | ✅ shipped         | Metadata/status filter + pagination; copy duplicates history.                        |
| Store item TTL                           | ✅ shipped         | `store.ttl` (default/refresh-on-read/sweep) + per-put `ttl`.                         |
| Thread TTL                               | ✅ shipped         | `checkpointer.ttl` + per-thread `ttl`; past LangGraph OSS, which drops it.           |
| Distinct cancelled run status            | ✅ shipped         | Cancel resolves to `cancelled`, not `error`.                                         |
| Human-in-the-loop (interrupt/resume)     | ✅ shipped         | Via LangGraph checkpointers.                                                         |
| Auth + authorization                     | ✅ shipped         | LangGraph `Auth` parity — see below.                                                 |
| Multitask / double-texting               | ✅ shipped         | `reject` (422) / `enqueue` / `interrupt` / `rollback`.                               |
| Multi-instance double-texting            | ✅ shipped         | Atomic create guard, cross-instance cancel, and a per-thread execution claim.        |
| **Cron / scheduled runs**                | ✅ shipped         | Full Crons resource + scheduler; works on every driver. See [crons.md](./crons.md).  |
| Stateless + batch run endpoints          | ✅ shipped         | `POST /runs`, `/runs/batch`, `/runs/cancel` (cancelMany).                            |
| `POST /threads/count` · `/threads/prune` | ✅ shipped         | `delete` and `keep_latest` prune strategies.                                         |
| Time travel (fork from checkpoint)       | ✅ shipped         | Update state at a checkpoint + fork a run from one; rides the checkpointer.          |
| Assistants CRUD + versioning             | ✅ shipped         | Create/update/delete + version history/rollback; graph/subgraphs.                    |
| **MCP endpoint (`/mcp`)**                | 🗺️ planned         | LangGraph exposes graphs as MCP tools; not yet implemented.                          |
| Run-completion webhooks                  | ✅ shipped         | `webhook` URL POSTed the settled run on completion.                                  |
| **Idempotent run creation**              | ✅ shipped         | `Idempotency-Key` on the creates; **LangGraph Platform has no equivalent**.          |
| True `events` stream mode                | ✅ shipped         | Real `streamEvents` (v2); full token/tool/step granularity.                          |
| Fastify / NestJS adapters                | ✅ shipped         | Plugin / `SkeinModule`; standalone + embedded examples.                              |
| Next.js API-route adapter                | ✅ shipped         | App Router + Pages Router; same-origin, `useStream` UI example.                      |
| `http.disable_*` route flags             | ✅ shipped         | `disable_assistants`/`threads`/`runs`/`store`/`meta`; `/ok` is never disabled.       |
| `GET /info` capability handshake         | ✅ shipped         | Version + `flags`; `/ok` stays outside the table so no flag can break the probe.     |
| Blocking run join · state-at-checkpoint  | ✅ shipped         | `runs.join()`, `threads.getState()` with an object checkpoint, `/stream/events`.     |
| Generative UI (`/ui/{agent}`)            | 🗺️ planned         | `LoadExternalComponent`; needs a `ui` config block, a bundler, and asset serving.    |
| `/docs` OpenAPI page                     | 🗺️ planned         | LangGraph Server serves one; `skein dev` links the published docs instead.           |
| WebSocket streaming transport            | ❌ non-goal (v1)   | SSE covers the client UX; does not affect the React SDK.                             |
| `deploy` to a hosted platform            | ❌ non-goal        | skein-js is self-hosted by design.                                                   |
| OpenTelemetry / tracing observability    | ✅ shipped         | `TelemetrySink` seam + LangSmith, PostHog, and OTel adapters.                        |

## Non-goals for v1

Deliberately out of scope for the first stable release (may be revisited later):

- **WebSocket streaming transport** — SSE covers the client UX and **does not affect the React SDK**.
- **`skein deploy` to a hosted platform** — skein-js is self-hosted by design; there's no managed
  target to push to.

## Verification

| Layer                               | How                                                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**                            | vitest per package; storage drivers against a shared `SkeinStore` conformance suite; run-engine transitions; SSE frame mapping.                                                                     |
| **Conformance / e2e**               | `examples/express-basic` exercised by the real `@langchain/langgraph-sdk` client (`threads.create`, `runs.stream`, `runs.wait`). If the official SDK is happy, the wire format is right.            |
| **SDK drift guards**                | Workspace-level tests diff skein against the _installed_ SDK: `routes.test.ts` on the route table, `sdk-body-parity.test.ts` on every request body. A field skein neither reads nor names fails CI. |
| **Drop-in migration (headline)**    | `examples/migrated-langgraph` with a real `langgraph.json` run via `skein dev` in place of `langgraph dev`, no other change.                                                                        |
| **React `useStream` (headline FE)** | `examples/react-usestream` streams a reply token-by-token from skein-js — pointed at the `examples/gemini-chat` Gemini backend for a live model-backed FE+BE run.                                   |
| **Interop**                         | Agent Chat UI points at the local server; streamed conversation renders.                                                                                                                            |
| **Browser e2e (flagship)**          | `examples/chat-app` — Playwright drives the shadcn UI end to end, asserting streamed tokens, a rendered thinking block, and a tool-call card (key-gated).                                           |
| **Long-term memory**                | `@skein-js/agent-protocol` run-engine test: a node writes and reads via the injected `getStore()`; `examples/chat-app` recalls a saved fact across threads.                                         |
| **Postgres + Redis**                | Conformance suite re-run against Postgres; cross-instance test — start a run on instance A, join its SSE stream from instance B via Redis.                                                          |

See the top-level [plan](../README.md) and each feature doc for detail.
