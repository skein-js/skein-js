# Runs & Redis

This doc covers how skein-js executes runs and how it scales horizontally — modeled on
[aegra](https://github.com/aegra/aegra)'s worker + Redis architecture, adapted to Node.

> **Reuse note:** `@skein-js/redis` is the run **queue + pub/sub** — the piece LangGraph OSS
> does not provide (the open [`@langchain/langgraph-api`](https://www.npmjs.com/package/@langchain/langgraph-api)
> server runs runs in-process, in-memory). It is _not_ a checkpointer; for Redis-backed
> checkpoints use `@langchain/langgraph-checkpoint-redis`. See [reuse.md](./reuse.md).

## Contents

- [Run modes](#run-modes)
- [Run engine](#run-engine)
- [Queue drivers](#queue-drivers)
- [Run concurrency](#run-concurrency)
- [Deployment topology (`skein up`)](#deployment-topology-skein-up)

## Run modes

The [Agent Protocol](./agent-protocol.md) defines three ways to execute a graph:

| Mode           | Endpoint                                     | Behavior                                                   |
| -------------- | -------------------------------------------- | ---------------------------------------------------------- |
| **wait**       | `POST /runs/wait`, `GET /runs/{id}/wait`     | Run to completion, return final output.                    |
| **stream**     | `POST /runs/stream`, `GET /runs/{id}/stream` | [SSE](./streaming.md) as output is produced.               |
| **background** | `POST /threads/{id}/runs`                    | Enqueue; poll (`GET /runs/{id}`) or join its stream later. |

A **per-thread concurrency guard** prevents two active runs on the same thread (the protocol's
concurrency-control requirement). That is a different thing from
[run concurrency](#run-concurrency) below, which is how many runs on _different_ threads one
instance executes at once.

## Run engine

`@skein-js/agent-protocol` owns a run engine that:

1. Resolves the target graph via [`@skein-js/config`](./langgraph-cli-compat.md).
2. Persists a run row through [`SkeinStore`](./storage.md) (`pending → running → success/error`).
   A failed run also records _why_ on the row, so `GET /threads/{tid}/runs/{rid}` can still explain
   it afterwards — see [errors and logging](./errors-and-logging.md).
3. Invokes the graph (`invoke` for wait, `stream` for streaming), threading the LangGraph
   **checkpointer** so state/history persist and **interrupt/resume** (human-in-the-loop)
   works.
4. Publishes stream frames to subscribers (local bus or Redis pub/sub).

## Queue drivers

The engine talks to a small `RunQueue` / `RunEventBus` interface (`@skein-js/core`) with two
implementations. `RunQueue` is **processor-driven**: `enqueue(run)` adds a job and
`consume(process)` registers a worker that drains the queue — so the same run worker code drives
both drivers. Delivery is **at-least-once** (a crashed processor's run is redelivered); the worker
makes this safe by skipping any run already terminal in the store.

### In-memory (dev)

- Single-process queue + event bus. No external services.
- Used by `skein dev` so nothing beyond Node is required locally.

### `@skein-js/redis` (prod)

- **Job queue ([BullMQ](https://docs.bullmq.io))** — background runs are enqueued in Redis; worker
  processes across instances consume and execute them. BullMQ provides retries, backoff, and
  concurrency out of the box.
- **Crash recovery** — a stalled job (its worker died mid-run) is moved back to the queue by
  BullMQ's stalled-job check and retried, so runs survive restarts.
- **Cross-instance pub/sub** — run stream frames are published to a Redis Stream + channel so a
  client connected to instance B can join a run executing on instance A (see [streaming.md](./streaming.md)).

This is the same shape aegra uses (Redis job queue + pub/sub, crash recovery, Postgres
checkpoints) — <https://github.com/aegra/aegra>.

## Run concurrency

How many **queued** (background) runs one instance executes at once. It defaults to **10**, matching
the LangGraph CLI's `--n-jobs-per-worker`, so a project moving off `langgraph dev` keeps its
throughput. Inline `wait`/`stream` runs never touch the queue and are unaffected.

**One worker, N concurrent runs.** skein runs a _single_ background worker whose consumer executes up
to N runs at a time — which is why the startup banner says `Starting 1 worker, up to 10 concurrent
runs` rather than `langgraph dev`'s `Starting 10 workers` (it really does spawn 10 loops; we don't).
The observable behavior is the same.

> **Upgrading from ≤ 0.9.0?** This default changed: background runs used to execute strictly one at a
> time. Nothing about your code or config needs to change, but each instance now does up to 10 runs
> concurrently — so check that your Postgres pool has headroom (see
> [pool sizing](./deploy.md#connection-budget)), and note that background runs on one thread
> using `multitask_strategy: "enqueue"` no longer execute in strict enqueue order. Set
> `SKEIN_RUN_CONCURRENCY=1` (or `--concurrency 1`) to restore the previous behavior exactly.

Three ways to set it, highest precedence first:

| Surface        | How                                                                          |
| -------------- | ---------------------------------------------------------------------------- |
| CLI flag       | `skein dev --concurrency 4` / `skein start -n 4` (`--n-jobs-per-worker` too) |
| Environment    | `SKEIN_RUN_CONCURRENCY=4`, or the LangGraph-compatible `N_JOBS_PER_WORKER=4` |
| Adapter option | `createExpressServer({ deps, worker: { maxConcurrency: 4 } })`               |

An explicit value wins, but the environment is still validated — so a typo'd
`SKEIN_RUN_CONCURRENCY` fails loudly at boot instead of being silently ignored. The environment is
the path that reaches a container: add it to the `skein up` compose `environment:` block or your
PaaS config.

**Per-thread ordering is unaffected.** Two runs on the same thread are serialized by the engine's
execution lock at _every_ concurrency, so the per-thread guard above holds regardless.

### Head-of-line blocking

A run waiting on a busy thread's lock still occupies a slot. So N queued runs on the _same_ thread
occupy N slots with N−1 merely waiting, and other threads wait behind them. Two things bound this:

- It needs an explicit opt-in. The default `multitask_strategy` is `"reject"`, and a pending run
  counts as active — so a second background run on a busy thread is rejected before it can queue.
  Only `multitask_strategy: "enqueue"` piles runs up on one thread.
- The worst case degrades to serial execution. No deadlock, no dropped run.

Relatedly, **ordering across background `"enqueue"` runs is not guaranteed above concurrency 1**:
several are dequeued at once and race for the thread's lock. This matches LangGraph at
`N_JOBS_PER_WORKER=10`, whose N worker loops have no cross-loop ordering guarantee either. If you
need strict FIFO across background runs on one thread, set concurrency to 1.

**Concurrency vs. replicas.** Raise concurrency when you have many independent threads and runs are
I/O-bound (model calls). Add instances when runs are CPU-bound, or when threads are long-lived and
serialized. Note each concurrent run holds a Postgres connection — see the pool-sizing note in
[deploy.md](./deploy.md#connection-budget).

## Deployment topology (`skein up`)

```
        ┌──────────┐     ┌──────────┐        clients (SSE)
        │ instance │     │ instance │  ◄───────────────────
        │    A     │     │    B     │
        └────┬─────┘     └────┬─────┘
             │  queue + pub/sub │
             └───────┬──────────┘
                 ┌───▼───┐        ┌───────────────┐
                 │ Redis │        │   Postgres    │
                 └───────┘        │ checkpoints + │
                                  │ resources +   │
                                  │ pgvector      │
                                  └───────────────┘
```

`skein up` brings this stack up via Docker Compose. Horizontal scaling is verified by
starting a run on instance A and joining its SSE stream from instance B through Redis (see
[roadmap.md](./roadmap.md#verification)).

To run the same topology on a hosted platform, the generated image is PaaS-friendly (binds the
injected `$PORT`, non-root, `/ok` health probe, graceful `SIGTERM`) — see
[deploy.md](./deploy.md) for what every platform needs, plus per-platform guides for Cloud Run,
Railway, Fly.io, Render, AWS, Kubernetes and a plain VPS.
