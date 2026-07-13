// @skein/core — the framework- and driver-agnostic heart of Skein. This slice ships the
// shared contract that everything downstream (config, storage drivers, adapters) consumes:
// the Agent Protocol wire types, the SkeinStore + queue interfaces, and the edge error type.
// The protocol handlers and run engine build on this next (see docs/roadmap.md).

// Agent Protocol wire types (re-exported from @langchain/langgraph-sdk — the wire contract).
export type {
  Assistant,
  AssistantBase,
  AssistantGraph,
  Checkpoint,
  Config,
  DefaultValues,
  GraphSchema,
  Interrupt,
  Item,
  Metadata,
  MultitaskStrategy,
  Run,
  RunStatus,
  SearchItem,
  StreamMode,
  Thread,
  ThreadState,
  ThreadStatus,
  ThreadTask,
} from "./wire/wire.js";

// Persistence contract for protocol resources.
export type {
  AssistantCreate,
  AssistantRepo,
  RunCreate,
  RunRepo,
  SkeinStore,
  StoreRepo,
  StoreSearchQuery,
  ThreadCreate,
  ThreadRepo,
  ThreadUpdate,
} from "./store/skein-store.js";
export { isTerminalRunStatus, TERMINAL_RUN_STATUSES } from "./store/skein-store.js";

// Run queue + streaming pub/sub contract.
export type { QueuedRun, RunEventBus, RunFrame, RunQueue } from "./queue/queue.js";

// Edge error type.
export { isSkeinHttpError, SkeinHttpError } from "./errors/skein-http-error.js";
export type { SkeinHttpErrorOptions } from "./errors/skein-http-error.js";
