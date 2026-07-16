# @skein-js/redis

> Redis job queue (BullMQ) and cross-instance pub/sub streaming for skein-js.

Part of **[skein-js](../../README.md)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — implemented (BullMQ queue + Redis Streams/pub-sub bus); integration tests need Docker.

> **Directory vs. name.** This package publishes as **`@skein-js/redis`** but lives on disk at
> `packages/runtime-redis`.

## What it does

Two [`@skein-js/core`](../core) drivers for **horizontal scaling** — the piece LangGraph OSS does not
provide:

- **`RedisRunQueue`** — a durable background-run job queue on **[BullMQ](https://docs.bullmq.io)**.
  Multiple worker instances share one queue; BullMQ provides retries, backoff, concurrency, and
  lease-based crash recovery (a stalled job whose worker died is moved back to the queue). Because a
  run can be redelivered, delivery is **at-least-once** — the run worker makes this safe by skipping
  any run already terminal in the store.
- **`RedisRunEventBus`** — cross-instance SSE fan-out. Each run's frames go to a Redis Stream
  (durable replay for late joiners / reconnects via `afterSeq`) **and** a pub/sub channel (live
  tail), so a client connected to instance B can join a run executing on instance A.

## Install

```bash
pnpm add @skein-js/redis
```

`ioredis` and `bullmq` are **bundled dependencies** — you do not install them separately. No peer
dependencies. Needs a reachable Redis; the URL is passed to each constructor.

## Usage

Construct with a Redis URL — there is no migration step:

```ts
import { RedisRunQueue, RedisRunEventBus } from "@skein-js/redis";

const queue = new RedisRunQueue(process.env.REDIS_URI!);
const bus = new RedisRunEventBus(process.env.REDIS_URI!);
// Injected into the engine as deps.queue / deps.bus.
// …on shutdown, release the connections:
await queue.dispose();
await bus.dispose();
```

You normally get these via `skein dev --queue redis` / `skein up` and
[`@skein-js/runtime`](../runtime), which reads `REDIS_URI` and constructs them for you.

## API

- **`class RedisRunQueue implements RunQueue`** — `new RedisRunQueue(url, options?)`.
  `enqueue(run)` · `consume(process, options?)` → `RunConsumer` · `dispose()`.
  **`RedisRunQueueOptions`** = `{ queueName?, attempts? }` (`queueName` default `"skein-runs"`, must
  not contain `:`; `attempts` default `1`).
- **`class RedisRunEventBus implements RunEventBus`** — `new RedisRunEventBus(url, options?)`.
  `publish(runId, frame)` · `close(runId)` · `subscribe(runId, afterSeq = 0)` · `dispose()`.
  **`RedisRunEventBusOptions`** = `{ keyPrefix?, streamTtlSeconds?, closedMarkerTtlSeconds?, closedCheckIntervalMs? }`
  (defaults `"skein"`, `3600`, `86400`, `1000`).

> `close(runId)` ends one run's stream; `dispose()` tears down the whole driver's connections.

## Reuse

This package is the run **queue + pub/sub** — not a checkpointer. For Redis-backed _checkpointing_
(a different concern), use `@langchain/langgraph-checkpoint-redis`.

## Learn more

- [Runs & Redis](../../docs/runs-and-redis.md) · [Streaming (SSE)](../../docs/streaming.md)
- [skein-js overview](../../docs/index.md) · [Reuse-first architecture](../../docs/reuse.md) · [Root README](../../README.md)

## License

[Apache-2.0](../../LICENSE)
