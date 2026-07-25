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