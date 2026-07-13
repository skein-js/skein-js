# @skein/core

> Framework-agnostic Agent Protocol engine for LangGraph.js — the heart of Skein.

Part of **[Skein](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — Phase 1. The shared **contract** is implemented; the run engine, handler table, and SSE mapping build on it next.

## What it does

Holds the Agent Protocol logic once, against _normalized_ types, so behavior is identical across every framework adapter and storage driver.

**Implemented now — the contract everything downstream imports:**

- **Wire types** re-exported from `@langchain/langgraph-sdk` (`Assistant`, `Thread`, `Run`, `RunStatus`, `Config`, `Metadata`, `Item`, `StreamMode`, …) — the single seam that pins the protocol version.
- **`SkeinStore`** — the persistence interface for protocol resources (`assistants` / `threads` / `runs` / `store`), including the `hasActiveRun` concurrency guard and `isTerminalRunStatus`.
- **`RunQueue` / `RunEventBus`** — the run queue + streaming pub/sub seams.
- **`SkeinHttpError`** — the typed edge error carrying an HTTP status.

**Next (see the [roadmap](../../docs/roadmap.md)):** the router/handler table, the run engine (wait / stream / background), and the stream-mode → SSE mapping.

## Usage

```ts
import { type SkeinStore, SkeinHttpError, isTerminalRunStatus } from "@skein/core";

// Storage drivers implement SkeinStore; adapters catch SkeinHttpError at the HTTP edge.
throw SkeinHttpError.notFound(`Thread "${id}" not found.`);
```

## Reuse

Will run graphs through `@langchain/langgraph` (`CompiledStateGraph.invoke`/`.stream`, interrupts/resume) and reuses `@langchain/langgraph-sdk` TypeScript types as the wire contract. It never reimplements the graph runtime or redefines the wire shapes.

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
