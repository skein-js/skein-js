// @skein-js/core — the framework- and driver-agnostic heart of skein-js. This slice ships the
// shared contract that everything downstream (config, storage drivers, adapters) consumes:
// the Agent Protocol wire types, the SkeinStore + queue interfaces, and the edge error type.
// The protocol handlers and run engine build on this next (see docs/roadmap.md).

// Agent Protocol wire types (re-exported from @langchain/langgraph-sdk — the wire contract).
export type {
  Assistant,
  AssistantBase,
  AssistantGraph,
  AssistantVersion,
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
  AssistantSearchQuery,
  AssistantUpdate,
  AssistantVersionsQuery,
  RunCreate,
  RunKwargs,
  RunRepo,
  SkeinStore,
  SkeinStoreSnapshot,
  StorePutOptions,
  StoreRepo,
  StoreSearchQuery,
  StoreTtlConfig,
  ThreadCreate,
  ThreadRepo,
  ThreadSearchQuery,
  ThreadUpdate,
} from "./store/skein-store.js";
export {
  isMetadataSubset,
  isTerminalRunStatus,
  TERMINAL_RUN_STATUSES,
} from "./store/skein-store.js";

// Run queue + streaming pub/sub contract.
export type {
  QueuedRun,
  RunConsumer,
  RunConsumerOptions,
  RunEventBus,
  RunFrame,
  RunProcessor,
  RunQueue,
} from "./queue/queue.js";

// Outbound JSON serializer that flattens LangChain messages to the Agent Protocol wire shape.
export { serializeWireJson } from "./wire/serialize-wire-json.js";

// Edge error type.
export { isSkeinHttpError, SkeinHttpError } from "./errors/skein-http-error.js";

// Authentication + authorization contract (the injectable engine consulted per request).
export type {
  AuthAction,
  AuthContext,
  AuthEngine,
  AuthFilters,
  AuthFilterValue,
  AuthResource,
  AuthUser,
} from "./auth/auth.js";
export type { SkeinHttpErrorOptions } from "./errors/skein-http-error.js";
