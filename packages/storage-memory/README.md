# @skein/storage-memory

> In-memory SkeinStore + queue driver for development and tests.

Part of **[Skein](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — not yet implemented (Phase 1).

## What it does

In-process implementation of `SkeinStore` (assistants / threads / runs / store items) plus a single-process run queue. Zero external services — powers `skein dev`. Validated against the shared `SkeinStore` conformance suite.

## Reuse

Pairs with `MemorySaver` from `@langchain/langgraph-checkpoint` for graph checkpoints.

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
