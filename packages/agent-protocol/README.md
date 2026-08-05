# @skein-js/agent-protocol

[![npm](https://img.shields.io/npm/v/%40skein-js%2Fagent-protocol?logo=npm&color=cb3837)](https://www.npmjs.com/package/@skein-js/agent-protocol)&nbsp;[![downloads](https://img.shields.io/npm/dm/%40skein-js%2Fagent-protocol?color=blue)](https://www.npmjs.com/package/@skein-js/agent-protocol)&nbsp;[![license](https://img.shields.io/npm/l/%40skein-js%2Fagent-protocol?color=green)](../../LICENSE)

> The framework-agnostic Agent Protocol **engine** — run engine, handler table, and SSE mapping. The heart of skein-js.

Part of **[skein-js](../../README.md)** — the open-source alternative to LangGraph Platform for TypeScript: a self-hosted [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — implemented. Depends only on the [`@skein-js/core`](../core) contracts and is designed to be consumed on its own.

This is **the engine** at the heart of skein-js: a complete, framework-agnostic implementation of the
Agent Protocol for LangGraph.js. Build your own server on it — any HTTP framework, any storage/queue —
by injecting a [`ProtocolDeps`](#the-injected-contract-protocoldeps).

## Contents

- [What it does](#what-it-does)
- [Install](#install)
- [Usage](#usage)
- [Two layers](#two-layers)
- [The injected contract (`ProtocolDeps`)](#the-injected-contract-protocoldeps)
- [API](#api)
- [Reuse](#reuse)
- [Learn more](#learn-more)
- [License](#license)

## What it does

The **run engine + protocol handler table + SSE mapping**, and nothing else. It has no opinion about
your HTTP framework, your database, your queue, or your CLI — every collaborator is **injected**.
Give it a store, a queue, an event bus, a checkpointer, and a way to resolve graphs, and it serves
assistants, threads, the three run modes (wait / stream / background), the store, and
human-in-the-loop interrupt/resume — wire-compatible with the official `@langchain/langgraph-sdk`
client.

## Install

```bash
pnpm add @skein-js/agent-protocol @skein-js/core
```

`@langchain/langgraph` and `@langchain/langgraph-sdk` are peer dependencies — install them too if
your project doesn't already depend on them:

```bash
pnpm add @langchain/langgraph @langchain/langgraph-sdk
```

## Usage

```ts
import { createProtocolRuntime } from "@skein-js/agent-protocol";

const runtime = createProtocolRuntime({
  store, // a SkeinStore (e.g. @skein-js/storage-memory, @skein-js/storage-postgres)
  graphs, // a GraphResolver — ids + load(id) + schemas(id) (e.g. @skein-js/config's registry)
  queue, // a RunQueue for background runs
  bus, // a RunEventBus for streaming fan-out
  checkpointer, // a LangGraph BaseCheckpointSaver (MemorySaver in dev)
  // optional: auth, logger, clock, logRunActivity, exposeErrorStacks, runTimeoutMs
});

// One-time startup: register an assistant per graph, then start processing background runs.
await runtime.service.assistants.registerGraphAssistants();
runtime.worker.start();

// `runtime.handlers` is a transport-neutral table an adapter (e.g. @skein-js/express) mounts.
// `runtime.service` is the typed engine you can also drive directly.
```

### Two layers

- **`service`** (`createProtocolService(deps)` / `runtime.service`) — framework-agnostic logic over
  already-validated, typed inputs. Returns plain values or an `AsyncIterable<RunFrame>`; throws
  `SkeinHttpError`. Use this to embed the engine directly.
- **`handlers`** (`runtime.handlers`) — a thin table of `(ProtocolRequest) => ProtocolResponse`
  handlers that validate raw input with Zod and delegate to the service. Framework adapters map
  their request/response objects onto `ProtocolRequest` / `ProtocolResponse`.

`createProtocolRuntime` builds the service, handlers, and background worker over **one shared
context**, so cancelling a run through the service actually aborts it in the worker. Use the
individual `createProtocolService` / `createProtocolHandlers` / `createRunWorker` factories only when
you don't run a worker in the same process.

### The injected contract (`ProtocolDeps`)

| Dependency             | Type                                           | Responsibility                                                                                              |
| ---------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `store`                | `SkeinStore` (core)                            | Protocol resource rows (assistants/threads/runs/store)                                                      |
| `graphs`               | `GraphResolver` (this package)                 | Resolve a `graph_id` to a compiled graph + schemas                                                          |
| `queue`                | `RunQueue` (core)                              | Hand background runs to a worker                                                                            |
| `bus`                  | `RunEventBus` (core)                           | Fan run frames out to streaming clients                                                                     |
| `checkpointer`         | `BaseCheckpointSaver` (`@langchain/langgraph`) | Graph state, history, and interrupt/resume                                                                  |
| `auth?`                | `AuthEngine` (core)                            | Per-request 401/403 + ownership filtering; absent = all allowed                                             |
| `logger?`              | `Logger` (this package)                        | Structured logging; default no-op                                                                           |
| `clock?`               | `Clock`                                        | Time source; default `() => new Date()`                                                                     |
| `logRunActivity?`      | `boolean`                                      | Log per-run start/finish, tool calls, interrupts (`skein dev --verbose`). A failed run is logged regardless |
| `exposeErrorStacks?`   | `boolean`                                      | Send a failed run's stack to the client (SSE frame + `Run.error`). Off by default; `skein dev` sets it      |
| `runTimeoutMs?`        | `number`                                       | Optional per-run wall-clock timeout → `"timeout"`                                                           |
| `threadTtl?`           | `ThreadTtlConfig` (core)                       | Thread expiry (`checkpointer.ttl`) — the sweeper's cadence; a per-thread `ttl` is collected regardless      |
| `abortChannel?`        | `RunAbortChannel` (core)                       | Carries a cancel to whichever instance is executing the run (Redis pub/sub)                                 |
| `threadExecutionGate?` | `ThreadExecutionGate` (core)                   | Cross-instance per-thread execution claim (a Postgres advisory lock)                                        |
| `telemetry?`           | `TelemetrySink[]` (core)                       | Tracing/metrics sinks; off by default and free when off                                                     |
| `webhookDispatcher?`   | `WebhookDispatcher` (this package)             | Delivers the run-completion `webhook`; inject to allowlist hosts                                            |
| `cronsEnabled?`        | `boolean`                                      | Whether this server serves crons — reported as `flags.crons` by `GET /info`                                 |
| `serverVersion?`       | `string`                                       | Reported by `GET /info`; the CLI supplies its own version                                                   |

Graph **state, history, and interrupt/resume are 100% LangGraph-native** via the checkpointer. The
`SkeinStore` owns only the protocol resource rows — it is deliberately not the checkpointer.

## API

- **Entry points:** `createProtocolRuntime(deps, options?)` →
  `{ service, handlers, worker, scheduler, threadTtlSweeper }` — the last two are always present, so a
  host never branches on whether they exist, and both start and stop with `worker`. `options` carries
  `worker`, `scheduler`, and `threadTtl` (sweep cadence);
  `createProtocolService` / `createProtocolServiceFromContext`; `createProtocolHandlers`; `createContext`;
  `createRunWorker(ctx, options?)` (`RunWorkerOptions`: `maxConcurrency` — queued runs at once,
  default `DEFAULT_RUN_CONCURRENCY` (10, matching the LangGraph CLI) — and `shutdownGraceMs`). The
  adapters surface this as `worker.maxConcurrency` and also read `SKEIN_RUN_CONCURRENCY` /
  `N_JOBS_PER_WORKER`; see [runs-and-redis.md](../../docs/runs-and-redis.md#run-concurrency).
- **Service surface** (`runtime.service`): `assistants` (`registerGraphAssistants`, `get`, `list`,
  `search`, `schemas`), `threads`
  (`create`/`get`/`list`/`search`/`count`/`patch`/`copy`/`prune`/`delete`/`history`/`getState`/`getStateAt`/`updateState`),
  `threadStream` (`stream` / `joinStream` / `command` — HIL resume, requires status `interrupted`),
  `runs` (`createWait`/`createStream`/`createBackground`/`get`/`listByThread`/`cancel`/`delete`/`join`/`finalStatus`),
  `store` (`put`/`get`/`delete`/`search`/`listNamespaces`).
- **Transport types:** `ProtocolRequest`, `ProtocolResponse` (`json` | `empty` | `sse`),
  `ProtocolHandler`, `ProtocolHandlers`. `ProtocolRequest.signal?: AbortSignal` is what makes
  `on_disconnect: "cancel"` work — an adapter aborts it when the client goes away. One that cannot
  observe disconnects omits it, and `"cancel"` degrades to `"continue"` rather than failing.
- **Background loops:** `createCronScheduler(ctx, options?)` (`CronScheduler`, `CronSchedulerOptions`,
  `CronTickSummary`) and `createThreadTtlSweeper(deps, options?)` (`ThreadTtlSweeper`,
  `ThreadTtlSweeperOptions`). Both are wired for you by `createProtocolRuntime`.
- **Thread seeding:** `Superstep` / `SuperstepUpdate` — the `supersteps` a `POST /threads` body may
  carry to import a conversation into a new thread's checkpoint history.
- **`SkeinBaseStore`** — bridges a `StoreRepo` into a LangGraph `BaseStore`, so graph nodes reach
  long-term memory via `getStore()`. The engine attaches one to every run.
- **SSE helpers** (for adapters writing the stream themselves): `SSE_HEADERS`, `encodeFrame`,
  `encodeTerminal`, `toSseEvents`, `parseAfterSeq`.

> **Note on duplicate type names.** `GraphResolver`, `CompiledGraphFactory`, `ResolvedGraph`, and
> `GraphSchemas` are exported here _and_ (structurally compatible copies) by [`@skein-js/config`](../config).
> `config`'s `GraphRegistry` satisfies this package's `GraphResolver` at wire-up time.

## Reuse

Runs graphs through `@langchain/langgraph` (`invoke`/`stream`, interrupts/resume) and uses the
injected `BaseCheckpointSaver` for state/history — never a reimplemented runtime. Wire types come
from `@langchain/langgraph-sdk` via [`@skein-js/core`](../core).

## Learn more

- [Agent Protocol surface](../../docs/agent-protocol.md) · [Streaming (SSE)](../../docs/streaming.md) · [Runs & Redis](../../docs/runs-and-redis.md)
- [Building your own adapter](../../docs/building-an-adapter.md) — mount this engine on any HTTP framework
- [skein-js overview](../../docs/index.md) · [Reuse-first architecture](../../docs/reuse.md) · [Root README](../../README.md)

## License

[Apache-2.0](../../LICENSE)
