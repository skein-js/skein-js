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
  Cron,
  CronCreateForThreadResponse,
  CronCreateResponse,
  CronSelectField,
  CronSortBy,
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
// The page-size bound is a value, not a type: both drivers apply it, so it has to be shared.
export {
  DEFAULT_MAX_PAGE_SIZE,
  INFLIGHT_RUN_STATUSES,
  isMetadataSubset,
  isTerminalRunStatus,
  requireValidMaxPageSize,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
} from "./store/skein-store.js";
export type {
  AssistantCreate,
  AssistantRepo,
  AssistantSearchQuery,
  AssistantUpdate,
  AssistantVersionsQuery,
  ClaimedCronRun,
  CronAuth,
  CronClaim,
  CronCreate,
  CronRepo,
  CronSearchQuery,
  CronSortKey,
  CronUpdate,
  Delivery,
  DeliveryAttemptResult,
  DeliveryCreate,
  DeliveryListQuery,
  DeliveryRepo,
  DeliveryStatus,
  DueCron,
  DueCronsQuery,
  DueDeliveriesQuery,
  DueDeliveryScan,
  FinalizedRun,
  IdempotencyClaim,
  IdempotencyClaimResult,
  IdempotencyRecord,
  IdempotencyRepo,
  IdempotencyStatus,
  Pagination,
  RecordedResponse,
  RecordedResponseInput,
  RunCreate,
  RunFinalization,
  RunKwargs,
  RunListQuery,
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
  ThreadTtlConfig,
  ThreadUpdate,
} from "./store/skein-store.js";

// Store traversal semantics. Shared rather than per-driver: the memory driver runs these directly
// and the Postgres driver mirrors them in SQL, so both the operator set and the matching rules have
// to have exactly one definition. The conformance suite holds the drivers to them.
export {
  isStoreFilterOperators,
  matchesItemFilter,
  parseStoreItemFilter,
  STORE_FILTER_OPERATORS,
  storeItemFilterProblem,
} from "./store/item-filter.js";
export type {
  StoreFilterCondition,
  StoreFilterOperators,
  StoreFilterScalar,
  StoreItemFilter,
} from "./store/item-filter.js";
export {
  compareNamespaces,
  hasNamespaceWildcard,
  isValidNamespaceDepth,
  matchesNamespacePrefix,
  matchesNamespaceQuery,
  matchesNamespaceSuffix,
  MAX_NAMESPACE_DEPTH,
  NAMESPACE_WILDCARD,
  truncateNamespaceDepth,
} from "./store/namespace-match.js";
export type { StoreNamespaceQuery } from "./store/namespace-match.js";

// Cross-instance per-thread execution serialization contract.
export type { ThreadExecutionGate, ThreadExecutionLease } from "./queue/thread-execution-gate.js";

// Cross-instance run cancellation contract.
export type {
  RunAbortChannel,
  RunAbortListener,
  RunAbortReason,
  RunAbortRequest,
  RunAbortSubscription,
} from "./queue/run-abort-channel.js";

// Outbound delivery scheduling contract — where a run-completion callback waits between attempts.
export type {
  DeliveryAttemptContext,
  DeliveryConsumer,
  DeliveryConsumerOptions,
  DeliveryProcessor,
  DeliveryQueue,
  QueuedDelivery,
  ScheduleDeliveryOptions,
} from "./queue/delivery-queue.js";

// Run queue + streaming pub/sub contract.
export type {
  EnqueueOptions,
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

// The deepest link of a `cause` chain — what a one-line failure report should say, as opposed to the
// wrapper that says where it happened.
export { rootCause, rootCauseMessage } from "./errors/root-cause.js";

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
