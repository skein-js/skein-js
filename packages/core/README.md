# @skein-js/core

> The shared Agent Protocol **contract** for skein-js — wire types, the `SkeinStore` interface, the queue / bus / auth seams, and the edge error type.

Part of **[skein-js](../../README.md)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — implemented. The run engine, handler table, and SSE mapping that build on this contract live in [`@skein-js/agent-protocol`](../agent-protocol).

## Contents

- [What it does](#what-it-does)
- [Install](#install)
- [Usage](#usage)
- [API](#api)
- [Reuse](#reuse)
- [Learn more](#learn-more)
- [License](#license)

## What it does

Holds the Agent Protocol _contract_ once, against _normalized_ types, so behavior is identical across
every framework adapter and storage driver. It **defines interfaces; it implements nothing** — the
drivers ([`storage-memory`](../storage-memory), [`storage-postgres`](../storage-postgres),
[`redis`](../runtime-redis)) implement these interfaces and the [engine](../agent-protocol) consumes
them. Everything downstream imports it:

- **Wire types** re-exported from `@langchain/langgraph-sdk` (`Assistant`, `Thread`, `Run`,
  `RunStatus`, `Config`, `Metadata`, `Item`, `StreamMode`, `Interrupt`, …) — the single seam that
  pins the protocol version. skein-js never redefines them.
- **`SkeinStore`** — the persistence interface for protocol resources (`assistants` / `threads` /
  `runs` / `store`), including the `hasActiveRun` concurrency guard and `isTerminalRunStatus`.
- **`RunQueue` / `RunEventBus` / `RunFrame`** — the background-run queue and streaming pub/sub seams.
- **`AuthEngine`** — the authentication + authorization contract (LangGraph-style custom auth),
  consulted per request by the engine when present.
- **`SkeinHttpError`** — the typed edge error carrying an HTTP status.
- **`serializeWireJson`** — flattens LangChain messages to the Agent Protocol wire shape for output.

## Install

```bash
pnpm add @skein-js/core
```

Peer dependencies (install once in your project): `@langchain/langgraph` and
`@langchain/langgraph-sdk`. `core` bundles nothing itself.

## Usage

You rarely import `core` directly — you get it transitively. You reach for it when **implementing a
driver** or **handling errors at the HTTP edge**:

```ts
import { type SkeinStore, SkeinHttpError, isTerminalRunStatus } from "@skein-js/core";

// Storage drivers implement SkeinStore…
export class MyStore implements SkeinStore {
  /* assistants / threads / runs / store repos */
}

// …and adapters throw/catch SkeinHttpError at the HTTP edge.
throw SkeinHttpError.notFound(`Thread "${id}" not found.`);
```

## API

- **Wire types** (re-exported from `@langchain/langgraph-sdk`): `Assistant`, `AssistantBase`,
  `AssistantGraph`, `Checkpoint`, `Config`, `DefaultValues`, `GraphSchema`, `Interrupt`, `Item`,
  `Metadata`, `Run`, `SearchItem`, `StreamMode`, `Thread`, `ThreadState`, `ThreadStatus`,
  `ThreadTask`; plus `RunStatus` and `MultitaskStrategy` derived from `Run`.
- **`interface SkeinStore`** — `{ assistants: AssistantRepo; threads: ThreadRepo; runs: RunRepo; store: StoreRepo }`.
  Each repo exposes CRUD + list/search; `RunRepo.hasActiveRun(threadId)` is the concurrency guard
  (`true` while a run is `pending`/`running`). Input types: `AssistantCreate`, `ThreadCreate`,
  `ThreadUpdate`, `RunCreate`, `RunKwargs`, `StoreSearchQuery`.
- **`TERMINAL_RUN_STATUSES`** / **`isTerminalRunStatus(status)`** — `success` / `error` / `timeout` /
  `interrupted` are terminal (a resume arrives as a fresh run).
- **`interface RunQueue`** — `enqueue(run)` + `consume(process, options?)` → `RunConsumer`.
  **`interface RunEventBus`** — `publish` / `close` / `subscribe(runId, afterSeq?)`. **`RunFrame`** =
  `{ seq, event, data }` (monotonic `seq` per run). Plus `QueuedRun`, `RunProcessor`, `RunConsumer`,
  `RunConsumerOptions`.
- **`interface AuthEngine`** — `authenticate(request)` (→ `AuthContext`, throws 401) + `authorize({ resource, action, value, context })` (→ `{ filters?, value }`, throws 403) + `matchesFilters(...)`. Plus `AuthContext`, `AuthUser`, `AuthResource`, `AuthAction`, `AuthFilters`, `AuthFilterValue`.
- **`class SkeinHttpError`** — `new SkeinHttpError(status, message, options?)` and the static helpers
  `badRequest` (400) / `unauthorized` (401) / `forbidden` (403) / `notFound` (404) / `conflict` (409) /
  `unprocessable` (422); `isSkeinHttpError(value)` narrows it.
- **`serializeWireJson(value): string`** — `JSON.stringify` replacement that flattens LangChain
  `BaseMessage`s to the wire shape the SDK / `useStream` / Agent Chat UI expect.

## Reuse

Reuses `@langchain/langgraph-sdk` TypeScript types as the wire contract rather than redefining them.
Graphs run through `@langchain/langgraph` (`CompiledStateGraph.invoke`/`.stream`, interrupts/resume)
in [`@skein-js/agent-protocol`](../agent-protocol) — never a reimplemented runtime.

## Learn more

- [Agent Protocol surface](../../docs/agent-protocol.md) · [Storage](../../docs/storage.md)
- [skein-js overview](../../docs/index.md) · [Reuse-first architecture](../../docs/reuse.md) · [Root README](../../README.md)

## License

[Apache-2.0](../../LICENSE)
