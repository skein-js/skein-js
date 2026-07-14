# @skein-js/redis

> Redis job queue and cross-instance pub/sub streaming for skein-js.

Part of **[skein-js](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha.

## What it does

Two `@skein-js/core` drivers for horizontal scaling:

- **`RedisRunQueue`** — a durable background-run job queue on **[BullMQ](https://docs.bullmq.io)**.
  Multiple worker instances share one queue; BullMQ provides retries, backoff, concurrency, and
  lease-based crash recovery (a stalled job whose worker died is moved back to the queue). Because
  a run can be redelivered, delivery is **at-least-once** — the run worker makes this safe by
  skipping any run already terminal in the store.
- **`RedisRunEventBus`** — cross-instance SSE fan-out. Each run's frames go to a Redis Stream
  (durable replay for late joiners / reconnects via `afterSeq`) **and** a pub/sub channel (live
  tail), so a client connected to instance B can join a run executing on instance A.

```ts
import { RedisRunQueue, RedisRunEventBus } from "@skein-js/redis";

const queue = new RedisRunQueue("redis://localhost:6379");
const bus = new RedisRunEventBus("redis://localhost:6379");
// Injected into the agent-protocol runtime as `deps.queue` / `deps.bus`.
```

## Reuse

This package is the run **queue + pub/sub** — the piece LangGraph OSS does not provide. For
Redis-backed _checkpointing_ (a different concern), use `@langchain/langgraph-checkpoint-redis`.

## Install

```bash
pnpm add @skein-js/redis
```

## Learn more

- [skein-js overview](../../docs/index.md)
- [Reuse-first architecture](../../docs/reuse.md)
- [Roadmap](../../docs/roadmap.md)

## License

[Apache-2.0](../../LICENSE)
