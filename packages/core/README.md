# @skein-js/core

> Framework-agnostic Agent Protocol engine for LangGraph.js — the heart of skein-js.

Part of **[skein-js](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — implemented. The run engine, handler table, and SSE mapping that build on this contract live in [`@skein-js/agent-protocol`](../agent-protocol).

## What it does

Holds the Agent Protocol _contract_ once, against _normalized_ types, so behavior is identical across every framework adapter and storage driver. Everything downstream imports it:

- **Wire types** re-exported from `@langchain/langgraph-sdk` (`Assistant`, `Thread`, `Run`, `RunStatus`, `Config`, `Metadata`, `Item`, `StreamMode`, …) — the single seam that pins the protocol version.
- **`SkeinStore`** — the persistence interface for protocol resources (`assistants` / `threads` / `runs` / `store`), including the `hasActiveRun` concurrency guard and `isTerminalRunStatus`.
- **`RunQueue` / `RunEventBus`** — the run queue + streaming pub/sub seams.
- **`SkeinHttpError`** — the typed edge error carrying an HTTP status.

## Usage

```ts
import { type SkeinStore, SkeinHttpError, isTerminalRunStatus } from "@skein-js/core";

// Storage drivers implement SkeinStore; adapters catch SkeinHttpError at the HTTP edge.
throw SkeinHttpError.notFound(`Thread "${id}" not found.`);
```

## Reuse

Reuses `@langchain/langgraph-sdk` TypeScript types as the wire contract rather than redefining them. Graphs run through `@langchain/langgraph` (`CompiledStateGraph.invoke`/`.stream`, interrupts/resume) in [`@skein-js/agent-protocol`](../agent-protocol) — never a reimplemented runtime.

## Install

```bash
pnpm add @skein-js/core
```

## Learn more

- [skein-js overview](../../docs/index.md)
- [Reuse-first architecture](../../docs/reuse.md)
- [Roadmap](../../docs/roadmap.md)

## License

[Apache-2.0](../../LICENSE)
