# Reuse-first architecture

> **Contributor / design doc.** This explains the reuse-first architecture that shapes skein-js — what
> it reuses from `@langchain/*` versus what it rebuilds. If you just want to _use_ skein-js, start with
> the [README](https://github.com/skein-js/skein-js/blob/main/README.md) and [docs index](./index.md). To contribute, see
> [CONTRIBUTING.md](https://github.com/skein-js/skein-js/blob/main/CONTRIBUTING.md) and [AGENTS.md](https://github.com/skein-js/skein-js/blob/main/AGENTS.md).

<!-- -->

> **Principle:** Reuse as much of the LangGraph open source as possible. Build only what
> LangGraph OSS does not already give us — and build that well.

LangChain publishes a large, **MIT-licensed** JavaScript ecosystem under
[`langchain-ai/langgraphjs`](https://github.com/langchain-ai/langgraphjs). Crucially — and
unlike the Python side, where the equivalent is not open — the **JS Agent Protocol dev server
itself is open source**
([`@langchain/langgraph-api`](https://github.com/langchain-ai/langgraphjs/tree/main/libs/langgraph-api), MIT).

So skein-js is deliberately _thin_. We stand on the OSS runtime, checkpointers, parser,
schemas, and SDK, and add only the **durable-production, multi-framework, drop-in-CLI**
layer that OSS does not provide.

## What skein-js reuses (dependencies, all MIT)

| Concern                       | LangGraph OSS package                        | How skein-js uses it                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph runtime                 | `@langchain/langgraph`                       | Run graphs via `CompiledStateGraph.invoke` / `.stream`; interrupts + resume for human-in-the-loop. Never reimplemented. Reached through `@skein-js/langgraph`, which is the only package that imports it at runtime.                                                                                                                |
| Checkpoint base + dev saver   | `@langchain/langgraph-checkpoint`            | `BaseCheckpointSaver`, `MemorySaver` for dev.                                                                                                                                                                                                                                                                                       |
| Postgres checkpoints          | `@langchain/langgraph-checkpoint-postgres`   | `PostgresSaver` for graph state in prod. Its `./store` `PostgresStore` is also usable as a drop-in long-term-memory store via `store.adapter` — see [storage.md](./storage.md#bringing-your-own-store-storeadapter) — which brings hybrid `text \| vector` search skein's own driver lacks.                                         |
| Long-term store interface     | `@langchain/langgraph-checkpoint`            | `BaseStore` in both directions: `SkeinBaseStore` (in `@skein-js/langgraph`, because it _extends_ `BaseStore`) exposes skein's store to graphs as one, and `fromBaseStore` (in `@skein-js/agent-protocol`, whose import is type-only) accepts anyone's as skein's store. `InMemoryStore` is the conformance target for that adapter. |
| Redis checkpoints             | `@langchain/langgraph-checkpoint-redis`      | Optional Redis-backed checkpointer. (Note: distinct from `@skein-js/redis`, which is the run **queue**.)                                                                                                                                                                                                                            |
| SQLite checkpoints            | `@langchain/langgraph-checkpoint-sqlite`     | `SqliteSaver` in `@skein-js/local`, sharing the SQLite resource driver's borrowed connection. LangGraph owns checkpoint tables and migrations.                                                                                                                                                                                      |
| Checkpointer conformance      | `@langchain/langgraph-checkpoint-validation` | Reused as-is in our test suite to validate any checkpointer wiring.                                                                                                                                                                                                                                                                 |
| **Agent Protocol dev server** | **`@langchain/langgraph-api`** (MIT)         | Reuse its public exports: `./schema` (the `langgraph.json` parser), `./auth`'s pure `isAuthMatching` (so our ownership-filter `$eq`/`$contains` semantics match), `./experimental/embed` (store-search embeddings). Its Zod schemas + in-memory handler logic (MIT) are the reference we adapt for the durable drivers.             |
| CLI + config semantics        | `@langchain/langgraph-cli`                   | Reference for `langgraph.json` fields and `dev/up/build/dockerfile` behavior we mirror.                                                                                                                                                                                                                                             |
| Wire types + JS client        | `@langchain/langgraph-sdk`                   | **Reuse the SDK's TypeScript types** for Thread/Run/Assistant/etc. as our wire contract instead of regenerating; also our conformance oracle.                                                                                                                                                                                       |
| React streaming               | `@langchain/react`                           | `useStream` — a target client we satisfy, not something we build. The dedicated Vue, Svelte and Angular packages share the thread event protocol; legacy React remains tested.                                                                                                                                                      |
| Chat UI                       | `langgraph-ui` / Agent Chat UI               | Interop target for smoke tests.                                                                                                                                                                                                                                                                                                     |

**Rule of thumb:** if a `@langchain/*` package already does it, we depend on it (as a
`peerDependency` where the consumer should own the version). We do not fork or vendor it.

Subgraph SSE event naming (`mode|<namespace>`) follows `@langchain/langgraph-api`'s `streamState`.
That helper is not a public export, so Skein mirrors only its wire encoding. Deep Agents itself
remains an upstream dependency used directly by application graphs.

## What skein-js rebuilds (the gap)

`@langchain/langgraph-api` is explicitly an **in-memory dev server** ("in-memory mode,
suitable for development and testing"), built on Hono and oriented around the CLI. It does
not aim to provide durable production infrastructure. That gap — the same one aegra fills
for Python — is skein-js's actual product:

| Gap in OSS                                                                               | skein-js package                                                          | Why it's needed                                                                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable persistence of **protocol resources** (assistants / threads / runs / store rows) | `@skein-js/storage-postgres` or `@skein-js/storage-sqlite` + `SkeinStore` | Protocol resources need durable storage for server or local deployment. Graph checkpoints reuse the upstream Postgres/SQLite saver.                       |
| Local resource and job admission                                                         | `@skein-js/storage-sqlite`                                                | One owned file commits protocol resources and queued jobs together; LangGraph continues to own execution and checkpoints.                                 |
| Durable **background-run queue** + **cross-instance pub/sub** streaming                  | `@skein-js/redis`                                                         | The OSS server runs runs in-process; horizontal scaling needs a real queue and fan-out.                                                                   |
| **Framework-native adapters**                                                            | `@skein-js/express` (· `@skein-js/fastify` · `@skein-js/nestjs`)          | The OSS server is Hono-only; teams want to mount the protocol into their existing Express/Fastify/Nest app.                                               |
| **Normalized protocol core** tying runtime + checkpointer + store + queue together       | `@skein-js/core`                                                          | Adapter- and driver-agnostic handlers so behavior is identical everywhere.                                                                                |
| **Drop-in production CLI**                                                               | `skein-js`                                                                | `skein dev/up/build/dockerfile` reading an unchanged `langgraph.json`, wiring the durable drivers.                                                        |
| **`langgraph.json` loading orchestration**                                               | `@skein-js/config`                                                        | Thin wrapper over `@langchain/langgraph-api`'s `./schema` parser, adding `skein.json` overrides and driver selection.                                     |
| **Channels for cross-provider workflows**                                                | `@skein-js/channels`                                                      | Skein supplies durable sources and destinations; LangGraph owns the workflow and writes an explicit destination intent to the existing callback/outbox.   |
| **Native and BullMQ access**                                                             | `@skein-js/agent-protocol` · optional `@skein-js/bullmq`                  | Compose existing authorization, run services, result storage and outbox around atomic admission/receipts. LangGraph still owns execution and checkpoints. |

## Consequences

- **Small surface, few bugs.** Most agent behavior lives in battle-tested LangChain code;
  skein-js's own code is persistence, transport, and wiring.
- **Version alignment.** Reused packages are `peerDependencies` so apps control the exact
  LangGraph version and avoid duplicate installs.
- **Upgrades are cheap.** When LangGraph ships new stream modes or schema fields, skein-js
  inherits them through the shared runtime/types instead of chasing them by hand.
- **Honest positioning.** skein-js is an open alternative to LangGraph Platform — "aegra for
  TypeScript" — with a narrower job to do, because on JS the server internals are already open. We
  add production durability, not a second server.

See [code-practices.md](./code-practices.md) for how we keep the code we _do_ write small
and neat, and [storage.md](./storage.md) / [runs-and-redis.md](./runs-and-redis.md) for the
rebuilt pieces in detail.

Thread protocol execution delegates to LangGraph’s public `streamEvents({version: "v3"})`;
subscription and reconnect do not invoke a graph. The legacy graph stream remains available for
run-based clients. MCP and A2A use their official SDKs for transport and canonical serialization,
while Skein’s existing authorization, run admission, queue, persistence and cancellation remain the
execution authority. A2A results live on run rows rather than in a second task database.

## Under the hood: what skein-js changes (transparently)

skein-js keeps the **contract** identical — same `langgraph.json`, same graph code, same Agent
Protocol on the wire, same clients — while re-implementing the runtime underneath with a different,
open, self-hostable set of building blocks. None of this requires a change on your side; it's the
"drop-in" promise honored at the implementation level.

**Same graph code, same config, same wire protocol.** skein-js reuses the LangGraph runtime,
checkpointers, the `langgraph.json` parser/schemas, and the SDK/types from the open
`@langchain/*` packages (see [reuse.md](https://github.com/skein-js/skein-js/blob/main/docs/reuse.md)). It only rebuilds the durable-production,
multi-framework, drop-in-CLI layer that isn't open — so your project moves over untouched.

**What we implement, and the tools we use:**

| Concern                  | skein-js implementation                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI                      | [commander](https://github.com/tj/commander.js) — the `skein dev`/`up`/`build`/`dockerfile` command surface, plus `skein start` (below).                                                                                                                                                                                                        |
| Dev graph loading        | [vite](https://vitejs.dev) loads your TypeScript graphs **in-process** — no separate build step. tsconfig `paths` aliases resolve, so graphs in an Nx/Turborepo/pnpm-workspace monorepo import shared workspace packages unchanged.                                                                                                             |
| Prod image build         | `skein build`/`up` bundle graphs (+ auth/embed) to plain JS with `vite.build()` at build time — same alias resolution as dev, anchored at the workspace root — into a self-contained `.skein/build` artifact. The slim image installs prod deps only and runs the compiled output via `skein start` (no vite, no runtime TypeScript transform). |
| Dev hot reload           | **State-preserving** reload on source change: your threads, runs, and memory survive the reload. `.env` is watched too, so filling in a missing model key reloads the graphs instead of needing a restart.                                                                                                                                      |
| Dev persistence          | Dev state is snapshotted to `.skein/` so it survives restarts (opt out with `--no-persist`).                                                                                                                                                                                                                                                    |
| Run queue (prod)         | [BullMQ](https://docs.bullmq.io) on Redis — background runs, retries, backoff, and crash recovery.                                                                                                                                                                                                                                              |
| Cross-instance streaming | [ioredis](https://github.com/redis/ioredis) + **Redis Streams**/pub-sub — join a run's SSE stream from any instance.                                                                                                                                                                                                                            |
| Postgres store (prod)    | [pg](https://node-postgres.com) + compiled-in schema migrations + **pgvector** semantic search.                                                                                                                                                                                                                                                 |
| Checkpoints (prod)       | LangGraph-native [`PostgresSaver`](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-postgres) — reused, not reinvented.                                                                                                                                                                                                    |

**Transparent improvements over `langgraph dev`.** Because the storage/queue are pluggable drivers,
`skein dev` can run against **production-shaped** Postgres/Redis **without Docker** (`--store
postgres --queue redis`), and dev state persists across restarts — both beyond the stock LangGraph
CLI dev server, and both fully opt-in. The wire behavior your clients see is unchanged either way.

If any of this ever _does_ change observable behavior versus the LangGraph CLI, that's a
compatibility bug — please [report it](https://github.com/skein-js/skein-js/issues).

## How it works

Every instance runs a ticker. Every 30 seconds (`SKEIN_CRON_TICK_MS`) it asks the store for enabled
crons whose `next_run_date` has arrived, and for each one:

1. Computes the **next** occurrence, from the later of the stored date and now — so a cron that fell
   behind lands in the future in one step rather than replaying the backlog.
2. **Claims** it with a single-row conditional `UPDATE` on the primary key, guarded by a claim token
   the store bumps on every write. If three instances see the same occurrence, exactly one wins; the
   others skip. No leader election, no distributed lock, no Redis.
3. Commits the claim **and the `pending` run row in one transaction**, then enqueues the run.

That third step is a transactional outbox, and it is what makes delivery durable. Advancing without
the run would silently skip the occurrence if the instance died in between; creating the run first
would re-fire it. Committed together, the worst case is a `pending` run that never reached the queue —
which the next tick re-enqueues. Because enqueue is idempotent (keyed on the run id) and the worker
skips runs already terminal, delivery is **at-least-once** and execution **exactly-once**.

The recovery sweep looks only at runs a cron produced. A bare `pending` is not enough to conclude a
run is waiting for a worker: an inline `wait`/`stream` run is written `pending` too and only becomes
`running` once it acquires its thread's lock, so one queued behind a long peer would look identical
while its caller waits to execute it in-process. Handing that to a worker would run the graph twice.

The run itself then goes through the ordinary run queue — on Redis that is BullMQ, so cron-fired runs
get its retries, backoff, and stalled-job crash recovery like any other background run.

Schedule state lives in the store rather than in the queue, because `enabled`, `sort_by=next_run_date`,
filtered `count`, and metadata search are all things a queue cannot serve — and because a schedule
that a `FLUSHALL` can erase while the API still reports it as enabled is worse than no schedule.

## Queue implementation notes

The engine talks to small `RunQueue` / `RunEventBus` interfaces (`@skein-js/core`) with queue
drivers for memory, SQLite, and Redis. `RunQueue` is **processor-driven**: `enqueue(run)` adds a job and
`consume(process)` registers a worker that drains the queue — so the same run worker code drives
each driver. Crash behavior depends on the queue: Redis can redeliver stalled work; SQLite records
abandoned attempts as failures; memory loses queued work on process exit. The worker skips runs
already terminal in the store.

`enqueue` takes an optional `{ delayMs }` — the run-create
[`after_seconds`](./agent-protocol.md). The driver holds the run until it comes due, which is why a
delayed run cannot be picked up early. The drivers dedupe a
re-enqueue of a run that is still waiting out its delay, so the cron scheduler's outbox sweep — which
re-enqueues anything it cannot prove reached the queue — can never cut a delay short or schedule the
same run twice. A delayed run is durable exactly as far as its driver is: see below.

### What a frame costs

Publishing sits inside the graph's own loop — the engine awaits it per chunk — so at token
granularity its cost is paid per token. It is **one pipelined round trip**: `XADD` and `PUBLISH`
batched together, with the frame serialized once for both. The stream's TTL is refreshed every 256
frames and on close, rather than on every frame, since the window only has to outlive the run.

All in-flight subscribers share **one** pub/sub connection, with a `SUBSCRIBE` per run rather than a
connection per stream — an instance serving 500 SSE streams holds two Redis sockets, not 501.

Replay is paged (`XRANGE … COUNT`), and a reconnecting subscriber resumes from the last stream id it
read rather than re-reading the whole stream.

The worker uses the optional `RunQueue.consumePartitioned` and, when a backend gate is configured,
`ThreadExecutionGate.tryAcquire` capabilities. Existing third-party queues or gates without either
capability retain ordinary blocking dispatch. `tryAcquire` returns a lease or `undefined` for a busy
thread/capacity; backend errors still reject. A partitioned processor returns `true` only after handling
a run and `false` when execution never started. A false result retains identity and ordering position.

Redis continues using BullMQ jobs, delay floors, retries and stalled-job recovery. Internal partition
metadata registers jobs when first eligible, parks followers, and promotes the next head after
settlement. Promotion applies only to Skein-parked attempts; native BullMQ retry backoff remains in
force. Busy heads retry after 50 ms; followers have a 60-second parking backstop. A bounded sweep
reconciles up to 100 partitions per second after crashes or removals. Registration never promotes a
run before its original `after_seconds` delay. Empty metadata is removed. Existing queued jobs register
lazily, so an upgrade does not require flushing the queue. Coordinate worker upgrades to obtain the
new dispatch behavior throughout the deployment; the execution claim remains the safety boundary.

SQLite keeps the original job sequence and due time, with no schema migration. Abandoned attempts
still fail without automatic replay. Deferred work is not a new recovery policy.

## Bundle regression history

That is asserted, not asserted-by-comment: `packages/test-support/src/static-imports.test.ts` walks each
adapter's built output — following `@skein-js/*` edges into their own `dist` — and fails if
`@langchain/langgraph-api`, `@typescript/vfs`, or `superjson` is statically reachable. The walk is
transitive because the regression it caught was: no adapter imported `@langchain/langgraph-api`, but
every adapter imported `@skein-js/server-kit`, which imported the `@skein-js/config` barrel for one error
class, and that barrel imported `@langchain/langgraph-api`.

Before 0.10.0 it located its `migrations/` directory with `new URL("../migrations", import.meta.url)`
and handed it to `node-pg-migrate`. Bundlers rewrite `import.meta.url` to the **output** location, so
a bundled build looked fine until boot, then failed to find its own SQL against a real database. If
you hit that on an older version, externalize `@skein-js/storage-postgres` (which then has to be
present in `node_modules` at runtime) or upgrade.

Migrations still run automatically on boot, tracked in a `skein_migrations` table and serialized by a
Postgres advisory lock — see [deploy.md](./deploy.md) and [storage.md](./storage.md).

## Storage implementation history

The memory driver holds versions in a second map; Postgres uses an `assistant_versions` table
(`PRIMARY KEY (assistant_id, version)`, `ON DELETE CASCADE` from `assistants`) added in migration
`0003`. Keep migrations enabled when upgrading a persistent deployment.
