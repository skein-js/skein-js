# @skein/storage-memory

> In-memory SkeinStore + queue driver for development and tests.

Part of **[Skein](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — Phase 1. Implemented and passing the shared conformance suite.

## What it does

Zero-dependency, in-process drivers that power `skein dev`:

- **`MemorySkeinStore`** — `SkeinStore` over plain `Map`s (assistants / threads / runs / store items), with the run-concurrency guard, thread→runs cascade delete, and naive prefix/substring store search. Every read and write deep-clones at the boundary — like a real serializing driver — so callers can't mutate stored rows or corrupt the store through a retained input.
- **`MemoryRunQueue`** — a single-process FIFO of background runs.
- **`MemoryRunEventBus`** — buffered run-frame pub/sub with replay (`afterSeq`) and live-tail, so a client can join a run's stream late or reconnect.

Validated against the shared `SkeinStore` conformance suite, so it behaves identically to the Postgres driver.

## Usage

```ts
import { MemorySkeinStore, MemoryRunQueue, MemoryRunEventBus } from "@skein/storage-memory";

const store = new MemorySkeinStore();
const thread = await store.threads.create({ metadata: { user: "a" } });
```

## Reuse

Pairs with `MemorySaver` from `@langchain/langgraph-checkpoint` for graph checkpoints — it stores only Agent Protocol _resources_, never graph state.

## Install

```bash
pnpm add @skein/storage-memory
```

## Learn more

- [Skein overview](../../docs/index.md)
- [Reuse-first architecture](../../docs/reuse.md)
- [Roadmap](../../docs/roadmap.md)

## License

[Apache-2.0](../../LICENSE)
