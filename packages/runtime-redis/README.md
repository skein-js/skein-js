# @skein-js/redis

> Redis job queue and cross-instance pub/sub streaming for skein-js.

Part of **[skein-js](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — not yet implemented (Phase 1).

## What it does

Durable background-run job queue with worker processes and lease-based crash recovery, plus cross-instance pub/sub so a client can join a run's SSE stream from any instance. Enables horizontal scaling.

## Reuse

This package is the run **queue + pub/sub**. For Redis-backed _checkpointing_, use `@langchain/langgraph-checkpoint-redis` instead — the two are complementary.

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
