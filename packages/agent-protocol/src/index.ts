// @skein-js/agent-protocol — a framework-agnostic implementation of LangChain's Agent Protocol for
// LangGraph.js. The run engine, protocol handler table, and SSE mapping, driven entirely by
// injected dependencies (see `ProtocolDeps`). This is the single public surface.

// Recommended entry point: service + handlers + worker over one shared context.
export { createProtocolRuntime } from "./runtime.js";
export type { ProtocolRuntime, ProtocolRuntimeOptions } from "./runtime.js";

// The framework-agnostic service (embed directly), and the advanced shared-context building blocks.
export { createContext } from "./context.js";
export type { ProtocolContext } from "./context.js";
export {
  buildProtocolService,
  createProtocolService,
  createProtocolServiceFromContext,
} from "./service.js";
export type { ProtocolService } from "./service.js";

// The transport-neutral HTTP handler table an adapter mounts.
export { createProtocolHandlers } from "./create-handlers.js";
export type {
  ProtocolHandler,
  ProtocolHandlers,
  ProtocolRequest,
  ProtocolResponse,
} from "./create-handlers.js";

// The transport-neutral route table + body-fold helper every framework adapter maps onto its router,
// plus a `matchSkeinRoute` matcher for adapters that dispatch from a catch-all (NestJS, Next.js).
export {
  copyThreadIdIntoBody,
  createRouteMatcher,
  filterSkeinRoutes,
  foldThreadId,
  matchSkeinRoute,
  skeinRoutes,
} from "./http/routes.js";
export type {
  DisabledRouteGroups,
  HttpMethod,
  RouteBinding,
  RouteGroup,
  RouteMatch,
  RouteMatcher,
} from "./http/routes.js";

// The simplified serving surface: one graph mounted as a plain endpoint (`POST /invoke/:graph_id`),
// for non-chat workloads that don't need threads/assistants/runs. See docs/serving-a-single-graph.md.
export {
  createGraphInvokeHandler,
  DEFAULT_INVOKE_PREFIX,
  graphInvokeRoutes,
} from "./invoke/graph-invoke.js";
export type { GraphInvokeHandlerName, GraphInvokeOptions } from "./invoke/graph-invoke.js";

export {
  advanceCronOccurrence,
  assertValidCronSchedule,
  nextCronOccurrence,
} from "./crons/cron-schedule.js";
export type { CronOccurrenceQuery } from "./crons/cron-schedule.js";
export {
  createCronScheduler,
  DEFAULT_CRON_BATCH_SIZE,
  DEFAULT_CRON_TICK_MS,
  DEFAULT_CRON_TICK_TIMEOUT_MS,
  DEFAULT_UNQUEUED_RUN_GRACE_MS,
} from "./crons/cron-scheduler.js";
export type {
  CronScheduler,
  CronSchedulerOptions,
  CronTickSummary,
} from "./crons/cron-scheduler.js";
export { createCronService } from "./crons/cron-service.js";
export type {
  CreateCronInput,
  CronService,
  SearchCronsInput,
  UpdateCronInput,
} from "./crons/cron-service.js";
// Verifying a skein callback. Exported for *receivers*: this package installs with no graph runtime,
// so a service whose only relationship with skein is receiving callbacks can depend on it for this.
export { SIGNATURE_HEADER, signDelivery } from "./crypto/sign-delivery.js";
export { verifySkeinSignature } from "./crypto/verify-delivery.js";
export type {
  SignatureFailure,
  VerifySignatureInput,
  VerifySignatureResult,
} from "./crypto/verify-delivery.js";

// Outbound run-completion delivery: the retry policy, and the worker that drains the outbox.
export { attemptDelivery } from "./deliveries/attempt-delivery.js";
export type { AttemptDeliveryDeps } from "./deliveries/attempt-delivery.js";
export { isFinalAttempt, nextAttemptDelayMs } from "./deliveries/backoff.js";
export {
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_RETAIN_HOURS,
  DELIVERY_LEASE_MARGIN_MS,
  deliveryLeaseMs,
  QUEUE_SWEEP_MARGIN_MS,
} from "./deliveries/delivery-config.js";
export type { DeliveryRetryConfig, WebhookDeliveryConfig } from "./deliveries/delivery-config.js";
export { buildDeliveryPayload, toDeliveryBody } from "./deliveries/delivery-payload.js";
export { toDeliveryRequest } from "./deliveries/delivery-request.js";
export type { DeliveryRequest } from "./deliveries/delivery-request.js";
export { processDelivery } from "./deliveries/delivery-processor.js";
export type { DeliveryProcessorDeps } from "./deliveries/delivery-processor.js";
export type { BuiltDeliveryPayload, TruncatedValues } from "./deliveries/delivery-payload.js";
export { createDeliveryWorker } from "./deliveries/delivery-worker.js";
export type {
  DeliveryTickSummary,
  DeliveryWorker,
  DeliveryWorkerOptions,
} from "./deliveries/delivery-worker.js";
export { idempotencyScope, requestFingerprint } from "./idempotency/fingerprint.js";
export type { IdempotencyConfig } from "./idempotency/idempotency-config.js";
export { createIdempotencySweeper } from "./idempotency/idempotency-sweeper.js";
export type {
  IdempotencySweeper,
  IdempotencySweeperOptions,
} from "./idempotency/idempotency-sweeper.js";
export { createIdempotentHandlers } from "./idempotency/idempotent-handlers.js";
export type { IdempotencyOptions } from "./idempotency/idempotent-handlers.js";
// The background run worker.
export {
  createRunWorker,
  DEFAULT_RUN_CONCURRENCY,
  DEFAULT_SHUTDOWN_GRACE_MS,
} from "./runs/run-worker.js";
export type { RunWorker, RunWorkerOptions } from "./runs/run-worker.js";
export { createThreadTtlSweeper } from "./threads/thread-ttl-sweeper.js";
export type { ThreadTtlSweeper, ThreadTtlSweeperOptions } from "./threads/thread-ttl-sweeper.js";

// The structured `meta` on the always-on failed-run log line. A console logger can recognize it and
// render a graph failure prominently; anything else just sees an object.
export { isRunFailureReport, RUN_FAILURE_REPORT_KIND } from "./runs/run-failure.js";
export type { RunFailureReport } from "./runs/run-failure.js";

// The injected dependency contract.
export { deliveryHeaders } from "./deps.js";
export type {
  Clock,
  CompiledGraphFactory,
  DeliveryAttempt,
  GraphResolver,
  GraphSchemas,
  Logger,
  ProtocolDeps,
  ResolvedGraph,
  WebhookDispatcher,
} from "./deps.js";

// The agent surface, named structurally so serving the protocol with a non-LangGraph runtime needs no
// cast. `CompiledGraph` satisfies `AgentGraph`, so this widens `ResolvedGraph` without breaking any
// existing resolver. `requireAgentCapability` turns a missing optional method into a handled 422
// instead of the unhandled TypeError (a bare 500) it used to be.
export { requireAgentCapability } from "./graphs/agent-graph.js";
// The resume/update/goto envelope, carried to the agent opaquely. A binding translates it into its
// runtime's own command type — `@skein-js/langgraph` builds a LangGraph `Command` from it — which is
// what keeps `new Command(...)` (a *runtime* import) out of this package.
export { agentCommand, agentCommandPayload, isAgentCommand } from "./graphs/agent-command.js";
export type { AgentCommand, AgentCommandParams } from "./graphs/agent-command.js";
export type {
  ThreadCheckpointer,
  ThreadCheckpointListOptions,
  ThreadCheckpointRecord,
  ThreadCheckpointTuple,
} from "./graphs/thread-checkpointer.js";
export type {
  AgentCheckpointRef,
  AgentGraph,
  AgentGraphCapability,
  AgentGraphFactory,
  AgentStateSnapshot,
  AgentStateTask,
} from "./graphs/agent-graph.js";

// The telemetry contract, re-exported from @skein-js/core so a sink author needs only this package.
export type {
  RunFinishedEvent,
  RunStartedEvent,
  RunTelemetryContext,
  RunTelemetryEvent,
  RunTrigger,
  TelemetrySink,
} from "@skein-js/core";

// Service input/output types (useful when building an adapter or driving the service directly).
export type {
  AssistantService,
  CreateAssistantInput,
  DeleteAssistantOptions,
  DrawGraphOptions,
  SubgraphsOptions,
} from "./assistants/assistant-service.js";
export type { MetaService, ServerInfo } from "./meta/server-info.js";
export type { StoreService } from "./store/store-service.js";

export type {
  CancelManyQuery,
  CancelManyResult,
  CancelRunOptions,
  CompletedWaitRun,
  CreateRunInput,
  RunService,
  StartedStream,
  WaitRunResult,
} from "./runs/run-service.js";
// The two store bridges, which are exact inverses of each other:
//
// `SkeinBaseStore` wraps a skein `StoreRepo` as a LangGraph `BaseStore`, and the run engine attaches one
// to every graph run so nodes reach long-term memory via `getStore()`.
//
// `fromBaseStore` goes the other way — a LangGraph `BaseStore` (`PostgresStore`, `InMemoryStore`, your
// own) serving skein's `/store/*` surface. It re-imposes skein's filter/namespace/paging semantics in JS
// rather than forwarding them; read its header for why forwarding would be unsafe. Pair it with
// `withStoreItems` (or `ProtocolDeps.storeItems`, which calls it) to substitute only the memory repo.
export {
  defaultAdapterScanLimit,
  fromBaseStore,
  supportsStoreTtl,
  type FromBaseStoreOptions,
} from "./store/from-base-store.js";
export { withStoreItems } from "./store/with-store-items.js";
export type {
  CreateThreadInput,
  HistoryOptions,
  PatchThreadInput,
  PruneThreadsInput,
  Superstep,
  SuperstepUpdate,
  ThreadService,
} from "./threads/thread-service.js";
export type {
  CommandInput,
  ThreadStreamInput,
  ThreadStreamService,
} from "./threads/thread-stream-service.js";

// SSE helpers, for adapters that write the event stream themselves.
export {
  DEFAULT_SSE_HEARTBEAT_MS,
  encodeFrame,
  encodeTerminal,
  parseAfterSeq,
  SSE_HEADERS,
  SSE_HEARTBEAT,
  toSseEvents,
  type SseOptions,
} from "./sse/sse.js";
// Every adapter's SSE write loop uses this: without it a slow client is served out of the server's
// memory, unbounded and per connection. See docs/streaming.md.
export {
  writeWithBackpressure,
  type BackpressuredWritable,
} from "./sse/write-with-backpressure.js";
