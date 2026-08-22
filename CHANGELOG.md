## 0.16.0 (2026-08-22)

### 🚀 Features

- **adapters:** let a provider's request reach a channel route ([#10](https://github.com/skein-js/skein-js/issues/10))
- **agent-protocol:** retry run-completion callbacks, with BullMQ owning the schedule ([2f632a0](https://github.com/skein-js/skein-js/commit/2f632a0))
- **agent-protocol:** sign run-completion callbacks, and let an operator see and replay them ([#9](https://github.com/skein-js/skein-js/issues/9))
- **agent-protocol:** let a callback carry the question, the answer, and a safe compare ([#36](https://github.com/skein-js/skein-js/issues/36))
- **channels:** the contract an inbound integration implements ([4a3c993](https://github.com/skein-js/skein-js/commit/4a3c993))
- **channels:** the route, the authorization, and the pipeline ([#10](https://github.com/skein-js/skein-js/issues/10))
- **channels:** deliver the answer through the outbox, not beside it ([#10](https://github.com/skein-js/skein-js/issues/10))
- **channels:** the WhatsApp example, run signals, and the docs ([#10](https://github.com/skein-js/skein-js/issues/10))
- **config:** read and load `skein.channels` from langgraph.json ([#10](https://github.com/skein-js/skein-js/issues/10))
- **core:** record a run's webhook delivery in the same transaction as its status ([a0b8248](https://github.com/skein-js/skein-js/commit/a0b8248))
- **core:** let a recorded attempt carry its number, and add a non-mutating due scan ([bd47ccb](https://github.com/skein-js/skein-js/commit/bd47ccb))
- **core:** refuse a run that would trample a thread waiting for a human ([#35](https://github.com/skein-js/skein-js/issues/35))
- **docs:** give skein-js a mark ([d703394](https://github.com/skein-js/skein-js/commit/d703394))
- **server-kit:** mount configured channels, and nothing when there are none ([#10](https://github.com/skein-js/skein-js/issues/10))

### 🩹 Fixes

- name the missing env var when a graph fails to load ([955adb7](https://github.com/skein-js/skein-js/commit/955adb7))
- regenerate the lockfile, and document ending a conversation ([7adb385](https://github.com/skein-js/skein-js/commit/7adb385))
- **agent-protocol:** close the gaps code review found in the delivery queue path ([ffc07d4](https://github.com/skein-js/skein-js/commit/ffc07d4))
- **agent-protocol:** close the second round of code-review findings ([f0a94f0](https://github.com/skein-js/skein-js/commit/f0a94f0))
- **agent-protocol:** close the code-review findings on signing and replay ([3c0ddea](https://github.com/skein-js/skein-js/commit/3c0ddea))
- **agent-protocol:** stop writing webhook credentials to logs, and allow refusing plaintext ([983c15e](https://github.com/skein-js/skein-js/commit/983c15e))
- **agent-protocol:** carry the declared reply on the pre-outbox path too ([ad46d6c](https://github.com/skein-js/skein-js/commit/ad46d6c))
- **channels:** ten review findings, three of which broke documented behaviour ([dd9fcf4](https://github.com/skein-js/skein-js/commit/dd9fcf4))
- **cli:** keep `skein dev` alive when `.env` changes ([7fbe7b6](https://github.com/skein-js/skein-js/commit/7fbe7b6))
- **create-skein-js:** declare `langchain`, which the agent template imports ([3300c81](https://github.com/skein-js/skein-js/commit/3300c81))
- **docs:** teach the link checker VitePress's two resolution rules ([0c8fc6e](https://github.com/skein-js/skein-js/commit/0c8fc6e))
- **docs:** pre-bundle mermaid so the dev server renders diagrams ([58119b3](https://github.com/skein-js/skein-js/commit/58119b3))
- **example:** declare @skein-js/server-kit, which the test imports ([90f50ca](https://github.com/skein-js/skein-js/commit/90f50ca))
- **server-kit:** accept what `createAgent` returns as an embeddable graph ([5f6171f](https://github.com/skein-js/skein-js/commit/5f6171f))
- **server-kit:** sign callbacks on the embed paths, instead of failing open ([#37](https://github.com/skein-js/skein-js/issues/37))

### 🔥 Performance

- **agent-protocol:** recover a lost delivery job in a sweep pass, not in hours ([69b4ee1](https://github.com/skein-js/skein-js/commit/69b4ee1))

### ❤️ Thank You

- Maina Wycliffe

## 0.15.0 (2026-08-09)

### 🚀 Features

- ⚠️  **agent-protocol:** serve the Agent Protocol with any agent runtime ([e902baa](https://github.com/skein-js/skein-js/commit/e902baa))

### ⚠️  Breaking Changes

- **agent-protocol:** serve the Agent Protocol with any agent runtime  ([e902baa](https://github.com/skein-js/skein-js/commit/e902baa))
  `SkeinBaseStore` moves from `@skein-js/agent-protocol` to
  `@skein-js/langgraph`. It cannot be re-exported for compatibility — a re-export
  is a static import and would undo the split. Update the import path;
  `fromBaseStore` (the inverse) stays where it is, because its `BaseStore` import
  is type-only.
  BREAKING CHANGE: a hand-assembled `ProtocolDeps` running LangGraph graphs must
  now wrap its resolver with `langGraphResolver()` and set `storeBridge`,
  `ephemeralCheckpointer` and `cloneCheckpoint`. Every documented on-ramp
  (`skein dev`/`start`, `buildRuntime`, `embedInMemoryGraphs`,
  `embedPostgresGraphs`) does this for you and is unaffected. Without the wrap,
  human-in-the-loop resume silently no-ops — see docs/embedding.md.

### ❤️ Thank You

- Maina Wycliffe

## 0.14.1 (2026-08-09)

### 🚀 Features

- **create-skein-js:** scaffold a project with one command ([480e095](https://github.com/skein-js/skein-js/commit/480e095))

### 🩹 Fixes

- **create-skein-js:** pin current model IDs for all three providers ([3056ebf](https://github.com/skein-js/skein-js/commit/3056ebf))

### ❤️ Thank You

- Maina Wycliffe

## 0.14.0 (2026-08-09)

### 🚀 Features

- **agent-protocol:** make run creation idempotent via Idempotency-Key ([4685dc1](https://github.com/skein-js/skein-js/commit/4685dc1))
- **agent-protocol:** erase idempotency records when their thread is deleted ([23f152a](https://github.com/skein-js/skein-js/commit/23f152a))
- **agent-protocol:** honour an `@auth.on.store` namespace rewrite, and document memory ([be1d273](https://github.com/skein-js/skein-js/commit/be1d273))
- **console:** add the skein console, served by the server at /console ([132a65e](https://github.com/skein-js/skein-js/commit/132a65e))
- ⚠️  **core:** filter store search, and traverse namespaces by prefix, suffix and depth ([58b1b5f](https://github.com/skein-js/skein-js/commit/58b1b5f))
- **runtime:** bring your own long-term store via `store.adapter` ([1ff89dd](https://github.com/skein-js/skein-js/commit/1ff89dd))

### 🩹 Fixes

- **agent-protocol:** close the gaps code review found in the idempotency work ([25e5039](https://github.com/skein-js/skein-js/commit/25e5039))
- ⚠️  **agent-protocol:** derive the auth payload's resource fields server-side ([ef635af](https://github.com/skein-js/skein-js/commit/ef635af))
- **agent-protocol:** close the review findings on the store namespace rewrite ([0d03b66](https://github.com/skein-js/skein-js/commit/0d03b66))
- **runtime:** advisory-lock the checkpointer's schema setup ([0097ebf](https://github.com/skein-js/skein-js/commit/0097ebf))
- **test-support:** read listNamespaces' response shape in the conformance run ([aef7948](https://github.com/skein-js/skein-js/commit/aef7948))

### 🔥 Performance

- **runtime-redis:** make the run close-check a backstop, not a heartbeat ([13eb228](https://github.com/skein-js/skein-js/commit/13eb228))
- **store:** stop reading whole run histories on the state path ([6395981](https://github.com/skein-js/skein-js/commit/6395981))

### ⚠️  Breaking Changes

- **agent-protocol:** derive the auth payload's resource fields server-side  ([ef635af](https://github.com/skein-js/skein-js/commit/ef635af))
  `value.namespace` in an `@auth.on.store` handler is now
  `string[]` on every store action, matching the SDK's declared types. It was the
  raw dot-joined query string on `GET`/`DELETE /store/items`, so a handler doing
  string operations on it (`value.namespace.startsWith(…)`, or `===` against a
  joined identity) needs updating.
  BREAKING CHANGE: `GET`/`DELETE /store/items` answer `400` instead of `404`/`204`
  when the request names no namespace or no key, or names a namespace containing a
  non-string segment.
- **core:** filter store search, and traverse namespaces by prefix, suffix and depth  ([58b1b5f](https://github.com/skein-js/skein-js/commit/58b1b5f))
  `StoreRepo.listNamespaces` takes a single `StoreNamespaceQuery`
  (`{ prefix, suffix, maxDepth, limit, offset }`) instead of `(prefix,
  pagination)`, which could not express a wildcard, a suffix or a depth —
  `listNamespaces(["users"])` becomes `listNamespaces({ prefix: ["users"] })`. It
  now also applies the driver page bound when no limit is given.
  BREAKING CHANGE: `POST /store/items/search` returns `{ items }` and
  `POST /store/namespaces` returns `{ namespaces }` instead of bare arrays, and
  store items carry `created_at`/`updated_at` instead of `createdAt`/`updatedAt`.
  This is what the LangGraph SDK already expected; the previous shapes could not
  be consumed by it.

### ❤️ Thank You

- Maina Wycliffe

## 0.13.1 (2026-08-05)

### 🚀 Features

- **runs:** honour if_not_exists, and make the three create routes agree ([#7](https://github.com/skein-js/skein-js/issues/7))
- **runs:** honour after_seconds by delaying delivery in the queue ([#7](https://github.com/skein-js/skein-js/issues/7))
- **runs:** honour on_disconnect, cancelling a run when the client hangs up ([#7](https://github.com/skein-js/skein-js/issues/7))
- **threads:** seed thread state from supersteps on create ([#7](https://github.com/skein-js/skein-js/issues/7))
- **threads:** expire threads on a TTL, configured via checkpointer.ttl ([#7](https://github.com/skein-js/skein-js/issues/7))

### 🩹 Fixes

- **runtime:** apply checkpointer.ttl on the skein dev path too ([#7](https://github.com/skein-js/skein-js/issues/7))
- **threads:** reject a duplicate thread_id and honour if_exists ([#7](https://github.com/skein-js/skein-js/issues/7))
- **threads:** close the gaps code review found in the #7 work ([#7](https://github.com/skein-js/skein-js/issues/7))

### ❤️ Thank You

- Maina Wycliffe

## 0.13.0 (2026-08-03)

### 🩹 Fixes

- **cli:** pin the packages the bundle actually imports ([#6](https://github.com/skein-js/skein-js/issues/6))

### ❤️ Thank You

- Maina Wycliffe

## 0.12.0 (2026-08-02)

### 🚀 Features

- **agent-protocol:** bound runs and webhooks, and get delivery off the thread lock ([7321cdd](https://github.com/skein-js/skein-js/commit/7321cdd))
- ⚠️  **agent-protocol:** close the LangGraph parity gaps and make double-texting multi-instance ([3f970c5](https://github.com/skein-js/skein-js/commit/3f970c5))
- **agent-protocol:** serve the last three SDK-reachable routes ([7fa5a3e](https://github.com/skein-js/skein-js/commit/7fa5a3e))
- **agent-protocol:** serve the crons resource over HTTP ([bd7c957](https://github.com/skein-js/skein-js/commit/bd7c957))
- **agent-protocol:** fire scheduled runs, and make delivery at-least-once ([79b70f6](https://github.com/skein-js/skein-js/commit/79b70f6))
- **bench:** add the performance benchmark harness ([ffd779f](https://github.com/skein-js/skein-js/commit/ffd779f))
- ⚠️  **cli:** require durable drivers for `skein start`, and harden the container ([9b6ef9c](https://github.com/skein-js/skein-js/commit/9b6ef9c))
- ⚠️  **core:** add a response headers channel and page runs and namespaces ([d6014bb](https://github.com/skein-js/skein-js/commit/d6014bb))
- ⚠️  **core:** add the crons persistence contract and both driver implementations ([083dc61](https://github.com/skein-js/skein-js/commit/083dc61))
- ⚠️  **otel:** parent graph spans under the run span, and harden the telemetry lifecycle ([6bd6d3a](https://github.com/skein-js/skein-js/commit/6bd6d3a))
- ⚠️  **server-fetch:** serve the protocol on Bun and Deno from a native Fetch transport ([c4b31bf](https://github.com/skein-js/skein-js/commit/c4b31bf))
- ⚠️  **server-kit:** keep dev-only tooling out of the adapter module graph ([4b8a3af](https://github.com/skein-js/skein-js/commit/4b8a3af))
- **server-kit:** warn when the heap fills up, with enough context to act on ([18681bc](https://github.com/skein-js/skein-js/commit/18681bc))
- **storage-postgres:** opt-in HNSW index for semantic store search ([713672b](https://github.com/skein-js/skein-js/commit/713672b))

### 🩹 Fixes

- **agent-protocol:** address code-review findings across the parity release ([e4e1dc0](https://github.com/skein-js/skein-js/commit/e4e1dc0))
- **agent-protocol:** correct the cron outbox sweep, and close a double-execution path ([b5cb822](https://github.com/skein-js/skein-js/commit/b5cb822))
- **cli:** pin dependency versions from the project, not the workspace root ([e488940](https://github.com/skein-js/skein-js/commit/e488940))
- **docs:** use stable Testcontainers links ([35aa4dc](https://github.com/skein-js/skein-js/commit/35aa4dc))
- **sse:** pace SSE writes to the client instead of buffering ([7e63ed8](https://github.com/skein-js/skein-js/commit/7e63ed8))
- **storage-memory:** bound what the in-memory event bus retains ([d1c5ba9](https://github.com/skein-js/skein-js/commit/d1c5ba9))
- **storage-postgres:** stop a killed backend from crashing the process ([4d61b00](https://github.com/skein-js/skein-js/commit/4d61b00))
- **storage-postgres:** avoid pgvector setup deadlocks ([8492bfc](https://github.com/skein-js/skein-js/commit/8492bfc))

### 🔥 Performance

- **agent-protocol:** bound thread history, and make the limit real ([91ac7c6](https://github.com/skein-js/skein-js/commit/91ac7c6))
- **agent-protocol:** push the auth ownership filter into the driver query ([d8d313f](https://github.com/skein-js/skein-js/commit/d8d313f))
- **core:** bound every store list and search to a page ([6d39d45](https://github.com/skein-js/skein-js/commit/6d39d45))
- **redis:** one round trip per frame, one connection per bus ([df31b68](https://github.com/skein-js/skein-js/commit/df31b68))
- **sse:** cache frame encoding and drop a redundant prototype walk ([cac874d](https://github.com/skein-js/skein-js/commit/cac874d))
- **storage-postgres:** index the list and search paths ([dfb450d](https://github.com/skein-js/skein-js/commit/dfb450d))
- **storage-postgres:** bound how long the database may not answer ([be7d550](https://github.com/skein-js/skein-js/commit/be7d550))
- **storage-postgres:** statement_timeout on by default, and batch the TTL sweep ([8c4add3](https://github.com/skein-js/skein-js/commit/8c4add3))

### ⚠️  Breaking Changes

- **core:** add the crons persistence contract and both driver implementations  ([083dc61](https://github.com/skein-js/skein-js/commit/083dc61))
  `SkeinStore` now requires a `crons: CronRepo`. Both bundled
  drivers implement it; a third-party driver must add one. `AuthResource` gains
  `"crons"` and `RunTrigger` gains `"cron"`, both additive unions that an exhaustive
  switch over either will need to handle.
- **agent-protocol:** close the LangGraph parity gaps and make double-texting multi-instance  ([3f970c5](https://github.com/skein-js/skein-js/commit/3f970c5))
  `RunService.createWait` returns `{ runId, threadId, result }`
  rather than the values alone, so the transport can set `Content-Location`.
  `StartedStream` gains `threadId` for the same reason.
- **otel:** parent graph spans under the run span, and harden the telemetry lifecycle  ([6bd6d3a](https://github.com/skein-js/skein-js/commit/6bd6d3a))
- **server-fetch:** serve the protocol on Bun and Deno from a native Fetch transport  ([c4b31bf](https://github.com/skein-js/skein-js/commit/c4b31bf))
- **core:** add a response headers channel and page runs and namespaces  ([d6014bb](https://github.com/skein-js/skein-js/commit/d6014bb))
- **cli:** require durable drivers for `skein start`, and harden the container  ([9b6ef9c](https://github.com/skein-js/skein-js/commit/9b6ef9c))
  `skein start --store memory` and `--queue memory` are rejected; both
  flags now default to the durable drivers. That combination stays supported on the
  embedded path (`embedPostgresGraphs` with no `REDIS_URI`) and under `skein dev`, where it
  is documented. Request logging is off by default under `skein start`; `--request-log` or
  `SKEIN_REQUEST_LOG=1` restores it.
- **server-kit:** keep dev-only tooling out of the adapter module graph  ([4b8a3af](https://github.com/skein-js/skein-js/commit/4b8a3af))
  `readLanggraphDevState`, `loadSnapshotIntoStore` and `describeSnapshot`
  move from `@skein-js/server-kit` (and its `@skein-js/express` re-export) to the
  `@skein-js/server-kit/dev` subpath. There is deliberately no deprecated alias: a
  re-export is still a static import, which would undo the split. The `DevStateCounts`
  type stays on the root barrel — `export type` is erased, so it costs nothing.

### ❤️ Thank You

- Maina Wycliffe

## Unreleased

### Behavior changes

- **`GET /threads/{thread_id}/runs` is paginated.** It now honours the `limit`/`offset` query params
  the LangGraph SDK has always sent (`runs.list` sends `limit ?? 10`) — previously both were dropped
  and every run on the thread was returned. With no `limit`, the default page is **100**. An
  over-ceiling `?limit=5000` is clamped to 1000, not rejected.
- **`POST /store/namespaces` is paginated**, defaulting to `limit: 100` — the same default the SDK's
  `store.listNamespaces` sends, so an SDK caller sees no change.
- **A telemetry provider declared in `langgraph.json` now fails startup when its configuration is
  incomplete** (missing API key, say), instead of silently running with telemetry off. An
  environment-*detected* provider still stays quietly off. Remove the `telemetry.<provider>` entry to
  run without it.
- **OpenTelemetry model/tool spans now nest under the run span** rather than being correlated with it
  by attribute. Dashboards built on a flat span structure will see a different shape.
- **`webhook` URLs are canonicalized** (`new URL(url).href`) before being stored, dispatched, and
  logged, so a round-tripped value can differ from the one submitted. This removes embedded control
  characters that `z.string().url()` accepts, which could otherwise forge lines in the server log.
- **Production images default to Node 24 LTS** (from 22), and the bundle's syntax target moves from
  Node 20 to 24. An explicit `node_version` is still honoured verbatim.
- `readLanggraphDevState` / `loadSnapshotIntoStore` / `describeSnapshot` remain at
  `@skein-js/server-kit/dev`; no root re-export, since that would undo the module-graph split.

### Features

- Add native Fetch transport (`@skein-js/fetch`) and production launchers/images for Node 24 LTS, Bun,
  and Deno, selectable with `skein.runtime`, `--runtime`, and `--runtime-version`. Bun and Deno are
  **preview** targets: their protocol conformance runs in CI, their performance is not yet published.
- Add a protocol conformance matrix and production-image smoke job covering all three runtimes, driven
  by the real `@langchain/langgraph-sdk`.
- Add `docs/profiling.md` — how to measure latency, memory, and CPU, and how to compare runtimes
  without fooling yourself.
- Add `/invoke` lifecycle telemetry, an active OpenTelemetry parent context, queue/frame metrics, and
  `x-pagination-total` on assistant search.

### Fixes

- **`skein build` works for a project inside a monorepo.** Dependency versions are pinned from the
  project's module tree instead of the workspace root, which in a pnpm workspace hoists nothing — so
  the build failed with `could not resolve an installed version of "@langchain/langgraph"`.
- **The generated Deno image runs.** `deno eval` rejects `--allow-*` flags, which broke the build-time
  graph probe and would have pinned the container permanently unhealthy; and `$HOME` now points inside
  the granted read scope, without which `langsmith`'s config probe failed **every run** with
  `NotCapable`.
- **The Fetch transport bounds request bodies** (413 above 100kb, matching `express.json()`), rather
  than reading an unbounded body into memory before validation.
- **A telemetry sink can no longer fail the run it observes** through `withRunContext`; it was the one
  sink method not guarded.
- **Heap-pressure warnings work on Bun and Deno.** They were silently disabled there by a heap limit
  nothing populated.
- Drain workers before production drivers on bind failures and shutdown, while stopping listeners from
  accepting new traffic first.
- Drain partially initialized telemetry sinks, and run exporter shutdown even when flush rejects.

## 0.11.3 (2026-07-27)

### 🩹 Fixes

- **cli:** stop advertising a /docs route the server does not serve ([f0e0a1b](https://github.com/skein-js/skein-js/commit/f0e0a1b))

### ❤️ Thank You

- Maina Wycliffe

## 0.11.2 (2026-07-26)

### 🚀 Features

- **adapters:** wire the logger option through to the run engine ([ebf810d](https://github.com/skein-js/skein-js/commit/ebf810d))

### ❤️ Thank You

- Maina Wycliffe

## 0.11.1 (2026-07-26)

### 🩹 Fixes

- **repo:** restore prettier to 3.9.x so format:check passes ([f592343](https://github.com/skein-js/skein-js/commit/f592343))

### ❤️ Thank You

- Maina Wycliffe

## 0.11.0 (2026-07-26)

### 🚀 Features

- **agent-protocol:** surface errors thrown inside graphs ([0fbfae4](https://github.com/skein-js/skein-js/commit/0fbfae4))
- **telemetry:** add LangSmith, PostHog, and OpenTelemetry sinks ([c07e763](https://github.com/skein-js/skein-js/commit/c07e763))

### ❤️ Thank You

- Maina Wycliffe

## 0.10.0 (2026-07-25)

### 🚀 Features

- ⚠️  **cli:** bind the container port by default so a bare `docker run` works ([841baff](https://github.com/skein-js/skein-js/commit/841baff))

### 🩹 Fixes

- **cli:** actually drain in-flight runs on SIGTERM instead of stranding them ([2149e8f](https://github.com/skein-js/skein-js/commit/2149e8f))
- **cli:** harden the shutdown path against the failure cases, not just the happy one ([628ed4d](https://github.com/skein-js/skein-js/commit/628ed4d))
- **redis:** don't orphan ioredis's handshake when a connection is closed early ([4430e0e](https://github.com/skein-js/skein-js/commit/4430e0e))
- **redis:** close BullMQ's connection only once it has finished connecting ([2acbff1](https://github.com/skein-js/skein-js/commit/2acbff1))
- **storage-postgres:** bundle migrations and resolve packages under require() ([fce9ed3](https://github.com/skein-js/skein-js/commit/fce9ed3))

### ⚠️  Breaking Changes

- **cli:** bind the container port by default so a bare `docker run` works  ([841baff](https://github.com/skein-js/skein-js/commit/841baff))
  `skein start` with no `--port` and no `PORT` in the environment
  now binds 8123 instead of 2024. The production image is unaffected — it already
  published 8123 — and `skein dev` is unchanged.

### ❤️ Thank You

- Maina Wycliffe

## 0.9.1 (2026-07-25)

### 🚀 Features

- ⚠️  **server-kit:** make background-run concurrency configurable ([0d7f06d](https://github.com/skein-js/skein-js/commit/0d7f06d))

### 🩹 Fixes

- **redis:** don't orphan a flushed command when a subscriber goes away ([21290c9](https://github.com/skein-js/skein-js/commit/21290c9))

### ⚠️  Breaking Changes

- **server-kit:** make background-run concurrency configurable  ([0d7f06d](https://github.com/skein-js/skein-js/commit/0d7f06d))
  background runs now execute up to 10 at a time instead of one at
  a time. The default matches the LangGraph CLI's `--n-jobs-per-worker`
  (and LangGraph Platform's `N_JOBS_PER_WORKER`), so a project moving off
  `langgraph dev` keeps its throughput rather than silently running 10x slower.
  Two things to check when upgrading:
    * Postgres pool headroom — each in-flight run holds connections from both pools
      an instance opens, so budget roughly concurrency x replicas against the cap,
      or raise PG_POOL_MAX.
    * Background runs on one thread using `multitask_strategy: "enqueue"` no longer
      execute in strict enqueue order; several are dequeued at once and race for
      the thread's execution lock. Per-thread serialization itself is unaffected.
      LangGraph behaves the same way at N_JOBS_PER_WORKER > 1.
  Set `SKEIN_RUN_CONCURRENCY=1` (or `--concurrency 1`) to restore the previous
  behavior exactly.

### ❤️ Thank You

- Maina Wycliffe

## 0.9.0 (2026-07-19)

### 🚀 Features

- **agent-protocol:** serve a graph as a plain endpoint ([c0f7e0f](https://github.com/skein-js/skein-js/commit/c0f7e0f))

### 🩹 Fixes

- **nestjs:** serve the protocol under app.setGlobalPrefix() ([b33fe4e](https://github.com/skein-js/skein-js/commit/b33fe4e))

### ❤️ Thank You

- Maina Wycliffe

## 0.8.0 (2026-07-19)

### 🚀 Features

- **agent-protocol:** time travel — fork from a past checkpoint ([9f66405](https://github.com/skein-js/skein-js/commit/9f66405))

### ❤️ Thank You

- Maina Wycliffe

## 0.7.0 (2026-07-18)

### 🚀 Features

- **runtime:** add embedPostgresGraphs in-code durable embedding ([#5](https://github.com/skein-js/skein-js/issues/5))
- **server-kit:** add in-code embedding on-ramp (createInMemoryDeps) ([5e2b26d](https://github.com/skein-js/skein-js/commit/5e2b26d))

### ❤️ Thank You

- Maina Wycliffe

## 0.6.3 (2026-07-17)

### 🩹 Fixes

- **release:** point package repository URL at skein-js/skein-js; scope publish build to packages ([fef1875](https://github.com/skein-js/skein-js/commit/fef1875))

### ❤️ Thank You

- Maina Wycliffe

## 0.6.2 (2026-07-17)

This was a version bump only, there were no code changes.

## 0.6.1 (2026-07-17)

### 🚀 Features

- **agent-protocol,server-kit:** extract shared adapter foundation ([84c9749](https://github.com/mainawycliffe/skein/commit/84c9749))
- **fastify:** add Fastify adapter + examples ([423e33d](https://github.com/mainawycliffe/skein/commit/423e33d))
- **nestjs:** add NestJS adapter + examples ([de2ec0a](https://github.com/mainawycliffe/skein/commit/de2ec0a))
- **nextjs:** add Next.js adapter (App + Pages Router) + examples ([339316d](https://github.com/mainawycliffe/skein/commit/339316d))

### ❤️ Thank You

- Maina Wycliffe

## 0.6.0 (2026-07-16)

### 🚀 Features

- **agent-protocol:** add assistants CRUD + versioning (LangGraph parity) ([f90006e](https://github.com/mainawycliffe/skein/commit/f90006e))
- **agent-protocol:** multitask strategies, run webhooks, true events mode ([caf4815](https://github.com/mainawycliffe/skein/commit/caf4815))
- **cli:** install prod deps from a private npm registry via a BuildKit secret ([#4](https://github.com/mainawycliffe/skein/issues/4))

### ❤️ Thank You

- Maina Wycliffe

## 0.5.0 (2026-07-16)

### 🚀 Features

- **agent-protocol:** inject authenticated user into run config ([#3](https://github.com/mainawycliffe/skein/issues/3))
- **cli:** ship a pre-built production image via skein start ([#2](https://github.com/mainawycliffe/skein/issues/2))

### ❤️ Thank You

- Maina Wycliffe

## 0.4.0 (2026-07-16)

### 🚀 Features

- thread search/copy, store TTL, and distinct cancelled run status ([c3560a3](https://github.com/mainawycliffe/skein/commit/c3560a3))
- ⚠️  use POSTGRES_URI/REDIS_URI env vars for LangGraph CLI parity ([d02477a](https://github.com/mainawycliffe/skein/commit/d02477a))
- **agent-protocol:** filter threads by graph via stamped metadata ([73f2fc9](https://github.com/mainawycliffe/skein/commit/73f2fc9))

### 🩹 Fixes

- **cli:** resolve tsconfig `paths` aliases in the dev graph loader ([#1](https://github.com/mainawycliffe/skein/issues/1))

### ⚠️  Breaking Changes

- use POSTGRES_URI/REDIS_URI env vars for LangGraph CLI parity  ([d02477a](https://github.com/mainawycliffe/skein/commit/d02477a))
  the postgres store now reads POSTGRES_URI (was
  DATABASE_URL) and the redis queue reads REDIS_URI (was REDIS_URL).
  Update your environment / compose / Railway variables accordingly. The
  skein-specific PG_POOL_MAX and DATABASE_SSL_NO_VERIFY tuning vars are
  unchanged.

### ❤️ Thank You

- Maina Wycliffe

## 0.3.0 (2026-07-15)

### 🚀 Features

- optimize production image and runtime for PaaS/Railway hosting ([a1adb0d](https://github.com/mainawycliffe/skein/commit/a1adb0d))
- **cli:** add startup banner and structured dev logging ([4243bb2](https://github.com/mainawycliffe/skein/commit/4243bb2))
- **cli:** import LangGraph in-memory dev state into skein ([57c8b15](https://github.com/mainawycliffe/skein/commit/57c8b15))

### 🩹 Fixes

- **example-migrated-langgraph:** await the startup banner's ready line in the dev e2e ([33783ef](https://github.com/mainawycliffe/skein/commit/33783ef))

### ❤️ Thank You

- Maina Wycliffe

## 0.2.1 (2026-07-15)

### 🩹 Fixes

- **release:** point package metadata at mainawycliffe/skein-js + enrich ([0e464b4](https://github.com/mainawycliffe/skein/commit/0e464b4))

### ❤️ Thank You

- Maina Wycliffe
