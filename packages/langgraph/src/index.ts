// @skein-js/langgraph — the LangGraph.js binding for @skein-js/agent-protocol.
//
// The engine drives an `AgentGraph`: a structural type naming only what skein calls. This package
// makes a LangGraph.js compiled graph one, and owns every LangGraph-specific decision that used to
// live in the engine — `Command` construction, the `BaseStore` bridge, the per-call checkpointer.
//
// It depends on `@skein-js/agent-protocol`, never the other way around, so the engine installs with
// no graph runtime. Guarded by `static-imports.test.ts`.

export { langGraphAgent } from "./lang-graph-agent.js";
export { langGraphResolver } from "./lang-graph-resolver.js";

// Bridges a skein `StoreRepo` into a LangGraph `BaseStore`, so graph nodes reach long-term
// cross-thread memory via `getStore()`. Lives here rather than in the engine because
// `class SkeinBaseStore extends BaseStore` is a *value* import of `@langchain/langgraph` — the one
// symbol whose move could not be an alias. See .agents/audit-overrides.md.
export { SkeinBaseStore } from "./skein-base-store.js";

// Clones a checkpoint before it is re-put under another thread id (thread copy, `keep_latest` prune,
// rollback). Wired onto `ProtocolDeps.cloneCheckpoint`; LangGraph's `copyCheckpoint` is a *value*
// import, and it was the last one keeping a graph runtime in the engine's install.
export { cloneLangGraphCheckpoint } from "./clone-checkpoint.js";
