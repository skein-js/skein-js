// @skein-js/agent-protocol — a framework-agnostic implementation of LangChain's Agent Protocol for
// LangGraph.js. The run engine, protocol handler table, and SSE mapping, driven entirely by
// injected dependencies (see `ProtocolDeps`). This is the single public surface.

// Recommended entry point: service + handlers + worker over one shared context.
export { createProtocolRuntime } from "./runtime.js";
export type { ProtocolRuntime, ProtocolRuntimeOptions } from "./runtime.js";

// The framework-agnostic service (embed directly), and the advanced shared-context building blocks.
export { buildProtocolService, createProtocolService } from "./service.js";
export type { ProtocolService } from "./service.js";
export { createContext } from "./context.js";
export type { ProtocolContext } from "./context.js";

// The transport-neutral HTTP handler table an adapter mounts.
export { createProtocolHandlers } from "./create-handlers.js";
export type {
  ProtocolHandler,
  ProtocolHandlers,
  ProtocolRequest,
  ProtocolResponse,
} from "./create-handlers.js";

// The background run worker.
export { createRunWorker } from "./runs/run-worker.js";
export type { RunWorker, RunWorkerOptions } from "./runs/run-worker.js";

// The injected dependency contract.
export type {
  Clock,
  CompiledGraphFactory,
  GraphResolver,
  GraphSchemas,
  Logger,
  ProtocolDeps,
  ResolvedGraph,
} from "./deps.js";

// Service input/output types (useful when building an adapter or driving the service directly).
export type { AssistantSearch, AssistantService } from "./assistants/assistant-service.js";
export type { StoreService } from "./store/store-service.js";

// The LangGraph `BaseStore` bridge over a skein `StoreRepo`, injected into every graph run so nodes
// reach long-term memory via `getStore()`. Exported for direct use in tests and embeddings.
export { SkeinBaseStore } from "./store/skein-base-store.js";
export type {
  CreateThreadInput,
  HistoryOptions,
  PatchThreadInput,
  ThreadService,
} from "./threads/thread-service.js";
export type {
  CommandInput,
  ThreadStreamInput,
  ThreadStreamService,
} from "./threads/thread-stream-service.js";
export type { CreateRunInput, RunService, StartedStream } from "./runs/run-service.js";

// SSE helpers, for adapters that write the event stream themselves.
export { encodeFrame, encodeTerminal, parseAfterSeq, SSE_HEADERS, toSseEvents } from "./sse/sse.js";
