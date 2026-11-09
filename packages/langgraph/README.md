# @skein-js/langgraph

> The **LangGraph.js binding** for [`@skein-js/agent-protocol`](../agent-protocol) — presents a
> compiled graph as the engine's `AgentGraph`.

Part of **[skein-js](https://skein.js.org/)** — the open-source TypeScript runtime for
LangGraph.js agents on shared servers or in local applications.

[Choose where to run](https://skein.js.org/#run-it-your-way) ·
[See who can connect](https://skein.js.org/#who-can-connect)

📖 **Docs:** [Embedding graphs](https://skein.js.org/embedding) · [Building a runner](https://skein.js.org/building-a-runner)

**Status:** 🚧 Pre-alpha — implemented.

## Why this package exists

`@skein-js/agent-protocol` drives an **`AgentGraph`**: a structural type naming only what the engine
calls (`stream` and `getState` required; `getStateHistory`, `updateState`, `bulkUpdateState`,
`streamEvents`, `invoke`, `getGraphAsync`, `getSubgraphsAsync` optional). A LangGraph.js
`CompiledGraph` satisfies that type already — but three things the engine used to do are
LangGraph-specific, and each was a **value** import of `@langchain/langgraph`:

| What                                                          | Now                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Building a `Command` to resume an interrupted run             | The engine emits a branded envelope (`agentCommand`); `langGraphAgent` translates it |
| Bridging long-term memory into a `BaseStore` for `getStore()` | `SkeinBaseStore`, injected as `ProtocolDeps.storeBridge`                             |
| Cloning a checkpoint when re-putting it under a new thread id | `cloneLangGraphCheckpoint`, injected as `ProtocolDeps.cloneCheckpoint`               |

Moving them here is what lets `npm i @skein-js/agent-protocol` pull **no graph runtime** — asserted
on the built entry by `static-imports.test.ts`, not merely documented.

This package depends on `@skein-js/agent-protocol`, never the reverse, and imports only its public
entry point. If it ever needs an internal, the internal is missing from the public API.

## You probably do not import this directly

Every on-ramp wires it for you — `skein dev`/`start`, `buildRuntime`, `embedInMemoryGraphs`,
`embedPostgresGraphs`. Reach for it when you assemble `ProtocolDeps` by hand.

```ts
import { createExpressServer } from "@skein-js/express";
import { cloneLangGraphCheckpoint, langGraphResolver, SkeinBaseStore } from "@skein-js/langgraph";
import { MemorySaver } from "@langchain/langgraph";

const deps = {
  store,
  queue,
  bus,
  checkpointer: new MemorySaver(),
  // Wrap the resolver so compiled graphs are presented as `AgentGraph`s.
  graphs: langGraphResolver(myResolver),
  // The three runtime-specific constructors the engine injects rather than imports.
  storeBridge: (repo) => new SkeinBaseStore(repo),
  ephemeralCheckpointer: () => new MemorySaver(),
  cloneCheckpoint: cloneLangGraphCheckpoint,
};

await createExpressServer({ deps }).listen(2024);
```

## API

- **`langGraphResolver(resolver)`** — a `GraphResolver` whose graphs are wrapped with
  `langGraphAgent`. Memoized per underlying graph, so `load()` stays identity-stable. Agent wrappers
  exposing a public compiled `.graph` (including current LangChain/Deep Agents) use that inner graph
  so injected resources do not invoke wrapper setters without their private state.
- **`langGraphAgent(compiled)`** — presents one compiled graph as an `AgentGraph`, translating
  command envelopes on `stream` / `streamEvents` / `invoke` / `bulkUpdateState`. Overrides live on a
  prototype clone and delegate with `this`, so the per-call checkpointer the engine attaches
  afterwards is still honoured.
- **`SkeinBaseStore`** — bridges a skein `StoreRepo` into a LangGraph `BaseStore`, so graph nodes
  reach long-term cross-thread memory via `getStore()`. The exact inverse of `fromBaseStore`, which
  stays in `@skein-js/agent-protocol` because its `BaseStore` import is type-only.
- **`cloneLangGraphCheckpoint(checkpoint)`** — delegates to LangGraph's own `copyCheckpoint`.
  Deliberately not reimplemented: it knows which fields are safe to share.

## Reuse

Everything here is a thin adapter over `@langchain/langgraph` — `Command`, `BaseStore`,
`copyCheckpoint`, `MemorySaver`. Nothing is reimplemented; see
[docs/reuse.md](https://github.com/skein-js/skein-js/blob/main/docs/reuse.md).

## License

Apache-2.0
