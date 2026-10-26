# @skein-js/redis

[![npm](https://img.shields.io/npm/v/%40skein-js%2Fredis?logo=npm&color=cb3837)](https://www.npmjs.com/package/@skein-js/redis)&nbsp;[![downloads](https://img.shields.io/npm/dm/%40skein-js%2Fredis?color=blue)](https://www.npmjs.com/package/@skein-js/redis)&nbsp;[![license](https://img.shields.io/npm/l/%40skein-js%2Fredis?color=green)](../../LICENSE)

> Redis job queue (BullMQ) and cross-instance pub/sub streaming for skein-js.

Part of **[skein-js](https://github.com/skein-js/skein-js)** — the open-source alternative to LangGraph Platform for TypeScript: a self-hosted [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

📖 **Docs:** [Runs & Redis](https://skein-js.github.io/skein-js/runs-and-redis#skein-js-redis-shared-servers)

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
  `enqueue(run, options?)` · `consume(process, options?)` · `consumePartitioned(tryProcess, options?)` → `RunConsumer` · `dispose()`.
  `options.delayMs` (the run-create `after_seconds`) becomes BullMQ's native `delay`, so the run is
  held in Redis and outlives the process that scheduled it — the durable half of the memory
  driver's timer.
  **`RedisRunQueueOptions`** = `{ queueName?, attempts? }` (`queueName` default `"skein-runs"`, must
  not contain `:`; `attempts` default `1`). `consume`'s `options.concurrency` (driver default `1`)
  becomes the BullMQ `Worker`'s concurrency — the run worker always passes an explicit value, so in
  practice this is [run concurrency](https://skein-js.github.io/skein-js/runs-and-redis#run-concurrency) (default 10).
- **`class RedisRunEventBus implements RunEventBus`** — `new RedisRunEventBus(url, options?)`.
  `publish(runId, frame)` · `close(runId)` · `subscribe(runId, afterSeq = 0)` · `dispose()`.
  **`RedisRunEventBusOptions`** = `{ keyPrefix?, streamTtlSeconds?, closedMarkerTtlSeconds?, closedCheckIntervalMs? }`
  — `closedCheckIntervalMs` (default 30s, jittered) is a **backstop**, not a heartbeat: a run's close is
  delivered live over pub/sub, and a subscriber joining after the run finished detects it with one eager
  check. The interval only bounds the stall when a terminal `PUBLISH` is lost to a connection drop, which
  a reconnect also pokes every subscriber to recheck.
  (defaults `"skein"`, `3600`, `86400`, `1000`).

> `close(runId)` ends one run's stream; `dispose()` tears down the whole driver's connections.

## Reuse

This package is the run **queue + pub/sub** — not a checkpointer. For Redis-backed _checkpointing_
(a different concern), use `@langchain/langgraph-checkpoint-redis`.

## Learn more

- [Runs & Redis](https://skein-js.github.io/skein-js/runs-and-redis) · [Streaming (SSE)](https://skein-js.github.io/skein-js/streaming)
- [skein-js overview](https://skein-js.github.io/skein-js/) · [Reuse-first architecture](https://github.com/skein-js/skein-js/blob/main/docs/reuse.md) · [Root README](https://github.com/skein-js/skein-js)

## License

[Apache-2.0](../../LICENSE)

## Partitioned dispatch

The run worker selects `consumePartitioned` when the execution gate supports non-blocking claims.
A callback returning `false` leaves the run at its thread's head and frees capacity for other threads;
`true` acknowledges it, and throws retain BullMQ's ordinary failure policy. BullMQ remains responsible
for job identity, delay, retry and stalled recovery. Internal Redis partition metadata survives worker
restart and is reconciled without reading BullMQ private keys. Upgrade all workers together for the
new utilization behavior; existing jobs are accepted without a queue flush.
