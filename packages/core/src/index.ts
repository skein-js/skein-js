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

// Run failure payload — the one shape carried by the `error` SSE frame, the persisted `Run.error`,
// and the `__error__` body of a failed `POST /runs/wait`.
export { runError, toRunError } from "./errors/run-error.js";
export type { RunError, ToRunErrorOptions } from "./errors/run-error.js";

// Telemetry contract — the injectable sink a run reports itself to (traces + lifecycle events).
// A third surface alongside logs and the wire; see docs/observability.md.
export { anySinkWantsRunEvents, combineTelemetrySinks } from "./telemetry/telemetry.js";
export type {
  RunFinishedEvent,
  RunStartedEvent,
  RunTelemetryContext,
  RunTelemetryEvent,
  RunTrigger,
  TelemetrySink,
  TelemetrySinkErrorReporter,
} from "./telemetry/telemetry.js";

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
