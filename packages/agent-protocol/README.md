# @skein-js/agent-protocol

A framework-agnostic implementation of LangChain's [**Agent
Protocol**](https://github.com/langchain-ai/agent-protocol) for [LangGraph.js](https://langchain-ai.github.io/langgraphjs/).

This package is the **run engine + protocol handler table + SSE mapping**, and nothing else. It has
no opinion about your HTTP framework, your database, your queue, or your CLI — every collaborator is
**injected**. Give it a store, a queue, an event bus, a checkpointer, and a way to resolve graphs,
and it will serve assistants, threads, the three run modes (wait / stream / background), the store,
and human-in-the-loop interrupt/resume — wire-compatible with the official `@langchain/langgraph-sdk`
client.

It powers [skein-js](https://github.com/mainawycliffe/skein), but it depends only on the `@skein-js/core`
contracts and is designed to be consumed on its own.

## Install

```sh
npm install @skein-js/agent-protocol @skein-js/core @langchain/langgraph @langchain/langgraph-sdk
```

## Usage

```ts
import { createProtocolRuntime } from "@skein-js/agent-protocol";

const runtime = createProtocolRuntime({
  store, // a SkeinStore (e.g. @skein-js/storage-memory, @skein-js/storage-postgres)
  graphs, // a GraphResolver — load(graphId) + schemas(graphId) (e.g. @skein-js/config's registry)
  queue, // a RunQueue for background runs
  bus, // a RunEventBus for streaming fan-out
  checkpointer, // a LangGraph BaseCheckpointSaver (MemorySaver in dev)
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
individual `createProtocolService` / `createProtocolHandlers` factories only when you don't run a
worker in the same process.

### The injected contract (`ProtocolDeps`)

| Dependency     | Contract (from `@skein-js/core`)               | Responsibility                                         |
| -------------- | ---------------------------------------------- | ------------------------------------------------------ |
| `store`        | `SkeinStore`                                   | Protocol resource rows (assistants/threads/runs/store) |
| `graphs`       | `GraphResolver`                                | Resolve a `graph_id` to a compiled graph + schemas     |
| `queue`        | `RunQueue`                                     | Hand background runs to a worker                       |
| `bus`          | `RunEventBus`                                  | Fan run frames out to streaming clients                |
| `checkpointer` | `BaseCheckpointSaver` (`@langchain/langgraph`) | Graph state, history, and interrupt/resume             |

Graph **state, history, and interrupt/resume are 100% LangGraph-native** via the checkpointer. The
`SkeinStore` owns only the protocol resource rows — it is deliberately not the checkpointer.

## License

Apache-2.0
