# Runs & Redis

This doc covers how skein-js executes runs and how it scales horizontally — modeled on
[aegra](https://github.com/aegra/aegra)'s worker + Redis architecture, adapted to Node.

> **Reuse note:** `@skein-js/redis` is the run **queue + pub/sub** — the piece LangGraph OSS
> does not provide (the open [`@langchain/langgraph-api`](https://www.npmjs.com/package/@langchain/langgraph-api)
> server runs runs in-process, in-memory). It is _not_ a checkpointer; for Redis-backed
> checkpoints use `@langchain/langgraph-checkpoint-redis`. See [reuse.md](./reuse.md).

## Run modes

The [Agent Protocol](./agent-protocol.md) defines three ways to execute a graph:

| Mode           | Endpoint                                     | Behavior                                                   |
| -------------- | -------------------------------------------- | ---------------------------------------------------------- |
| **wait**       | `POST /runs/wait`, `GET /runs/{id}/wait`     | Run to completion, return final output.                    |
| **stream**     | `POST /runs/stream`, `GET /runs/{id}/stream` | [SSE](./streaming.md) as output is produced.               |
| **background** | `POST /threads/{id}/runs`                    | Enqueue; poll (`GET /runs/{id}`) or join its stream later. |

A **concurrency guard** prevents two active runs on the same thread (the protocol's
concurrency-control requirement).

## Run engine

`@skein-js/agent-protocol` owns a run engine that:

1. Resolves the target graph via [`@skein-js/config`](./langgraph-cli-compat.md).
2. Persists a run row through [`SkeinStore`](./storage.md) (`pending → running → success/error`).
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
