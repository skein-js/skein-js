# @skein/core

> Framework-agnostic Agent Protocol engine for LangGraph.js — the heart of Skein.

Part of **[Skein](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — not yet implemented (Phase 1).

## What it does

Holds the Agent Protocol logic once, against *normalized* request/response types: the router/handler table, the run engine (wait / stream / background), the stream-mode → SSE mapping, and pluggable `SkeinStore` + queue + checkpointer seams. Framework adapters and storage drivers plug into it.

## Reuse

Runs graphs through `@langchain/langgraph` (`CompiledStateGraph.invoke`/`.stream`, interrupts/resume) and reuses `@langchain/langgraph-sdk` TypeScript types as the wire contract. It never reimplements the graph runtime.

## Install

```bash
pnpm add @skein/core
```

## Learn more

- [Skein overview](../../docs/index.md)
- [Reuse-first architecture](../../docs/reuse.md)
- [Roadmap](../../docs/roadmap.md)

## License

[Apache-2.0](../../LICENSE)
