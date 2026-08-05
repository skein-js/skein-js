// @skein-js/agent-protocol — a framework-agnostic implementation of LangChain's Agent Protocol for
// LangGraph.js. The run engine, protocol handler table, and SSE mapping, driven entirely by
// injected dependencies (see `ProtocolDeps`). This is the single public surface.

// Recommended entry point: service + handlers + worker over one shared context.
export { createProtocolRuntime } from "./runtime.js";
export type { ProtocolRuntime, ProtocolRuntimeOptions } from "./runtime.js";

// The framework-agnostic service (embed directly), and the advanced shared-context building blocks.
export {
  createProtocolServiceFromContext,
  buildProtocolService,
  createProtocolService,
} from "./service.js";
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

// The transport-neutral route table + body-fold helper every framework adapter maps onto its router,
// plus a `matchSkeinRoute` matcher for adapters that dispatch from a catch-all (NestJS, Next.js).
export {
  skeinRoutes,
  copyThreadIdIntoBody,
  filterSkeinRoutes,
  foldThreadId,
  matchSkeinRoute,
  createRouteMatcher,
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
  graphInvokeRoutes,
  DEFAULT_INVOKE_PREFIX,
} from "./invoke/graph-invoke.js";
export type { GraphInvokeOptions, GraphInvokeHandlerName } from "./invoke/graph-invoke.js";

// The background run worker.
export {
  createRunWorker,
  DEFAULT_RUN_CONCURRENCY,
  DEFAULT_SHUTDOWN_GRACE_MS,
} from "./runs/run-worker.js";
export type { RunWorker, RunWorkerOptions } from "./runs/run-worker.js";
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
export {
  advanceCronOccurrence,
  assertValidCronSchedule,
  nextCronOccurrence,
} from "./crons/cron-schedule.js";
export type { CronOccurrenceQuery } from "./crons/cron-schedule.js";
export { createCronService } from "./crons/cron-service.js";
export type {
  CreateCronInput,
  CronService,
  SearchCronsInput,
  UpdateCronInput,
} from "./crons/cron-service.js";

// The structured `meta` on the always-on failed-run log line. A console logger can recognize it and
// render a graph failure prominently; anything else just sees an object.
export { isRunFailureReport, RUN_FAILURE_REPORT_KIND } from "./runs/run-failure.js";
export type { RunFailureReport } from "./runs/run-failure.js";

// The injected dependency contract.
export type {
  Clock,
  CompiledGraphFactory,
  GraphResolver,
  GraphSchemas,
  Logger,
  ProtocolDeps,
  ResolvedGraph,
  WebhookDispatcher,
} from "./deps.js";

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
export type { StoreService } from "./store/store-service.js";
export type { MetaService, ServerInfo } from "./meta/server-info.js";

// The LangGraph `BaseStore` bridge over a skein `StoreRepo`, injected into every graph run so nodes
// reach long-term memory via `getStore()`. Exported for direct use in tests and embeddings.
export { SkeinBaseStore } from "./store/skein-base-store.js";
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

// SSE helpers, for adapters that write the event stream themselves.
export {
  DEFAULT_SSE_HEARTBEAT_MS,
  encodeFrame,
  encodeTerminal,
  parseAfterSeq,
  SSE_HEADERS,
  SSE_HEARTBEAT,
  type SseOptions,
  toSseEvents,
} from "./sse/sse.js";
// Every adapter's SSE write loop uses this: without it a slow client is served out of the server's
// memory, unbounded and per connection. See docs/streaming.md.
export {
  writeWithBackpressure,
  type BackpressuredWritable,
} from "./sse/write-with-backpressure.js";
