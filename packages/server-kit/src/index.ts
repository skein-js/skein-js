// @skein-js/server-kit — the framework-agnostic building blocks every skein-js HTTP adapter shares,
// so no adapter has to depend on another (or on Express) to reuse them: the in-memory dev runtime
// assembler, the LangGraph `.langgraph_api/` dev-state importer, the langgraph.json `http.cors` →
// `CorsOptions` mapping, the runtime CORS helpers, and the Node-`http` transport (SSE/JSON/error
// serialization) the two Node-based adapters (NestJS, Next.js Pages Router) share. The route table
// itself lives with the engine in @skein-js/agent-protocol (`skeinRoutes`); each framework adapter
// still maps it onto its own router. See docs/building-an-adapter.md.

// Runtime resolution: turn a `{ config } | { deps }` option bag into a live runtime (assistants
// seeded, worker started) — the shared step every adapter runs before mounting the route table.
// `resolveRuntimeDeps` stops at the deps (no assistants, no worker) — what the simplified invoke
// surface needs, since it never touches threads/assistants/runs.
export { resolveProtocolRuntime, resolveRuntimeDeps } from "./resolve-runtime.js";
export type {
  SkeinRuntimeCommonOptions,
  SkeinRuntimeOptions,
  ResolvedProtocolRuntime,
  ResolvedRuntimeDeps,
} from "./resolve-runtime.js";

// Logging. `createConsoleLogger` is the opt-in `Logger` for adapters whose framework owns none
// (Express, Next.js) — NestJS and Fastify default to bridges over the host's own logger instead.
// `formatLogMeta` + `describeError` are the shared rendering every line-oriented logger needs, so
// the bridges and the CLI's dev logger can't drift on how a failed run reads.
export { createConsoleLogger } from "./console-logger.js";
export type { ConsoleLoggerOptions, ConsoleLogLevel } from "./console-logger.js";
export { formatLogMeta, runFailureIdentity } from "./log-meta.js";
export { describeError } from "./describe-error.js";
export type { Logger } from "@skein-js/agent-protocol";

// How much the in-memory event bus may retain (SKEIN_MEMORY_BUS_*). Exported so a host assembling
// its own drivers bounds them the same way skein's own paths do.
export { resolveMemoryBusLimits, type ResolvedMemoryBusLimits } from "./memory-bus-limits.js";

// Run concurrency: the one precedence chain (explicit option → SKEIN_RUN_CONCURRENCY →
// N_JOBS_PER_WORKER → DEFAULT_RUN_CONCURRENCY) behind `worker.maxConcurrency`. Exported so
// `skein dev`/`start` resolve the exact number they print in the startup banner, rather than
// re-implementing the chain.
export {
  checkHeapHeadroom,
  describeHeapHeadroom,
  readContainerMemoryLimit,
  type FileReader,
  type HeapHeadroom,
} from "./heap-headroom.js";
export {
  DEFAULT_HEAP_SAMPLE_MS,
  DEFAULT_HEAP_WARN_PERCENT,
  HEAP_REARM_MARGIN_PERCENT,
  HEAP_REARM_PERCENT,
  resolveHeapPressureOptions,
  startHeapPressureMonitor,
  type HeapPressureContext,
  type HeapPressureMonitor,
  type HeapPressureMonitorOptions,
  type IntervalHandle,
} from "./heap-pressure.js";
export { resolveMaxPageSize } from "./max-page-size.js";
export { describePoolPressure, resolveRunConcurrency } from "./run-concurrency.js";
export { DEFAULT_RUN_CONCURRENCY } from "@skein-js/agent-protocol";
export type { RunWorkerOptions } from "@skein-js/agent-protocol";

// Shutdown drain window: the same shape for `worker.shutdownGraceMs` (explicit option →
// SKEIN_SHUTDOWN_GRACE_MS → DEFAULT_SHUTDOWN_GRACE_MS). Exported so a host that forces exit on a
// timer (the CLI does) can size that timer against the number the worker will actually use.
export { resolveShutdownGraceMs } from "./shutdown-grace.js";
export { DEFAULT_SHUTDOWN_GRACE_MS } from "@skein-js/agent-protocol";

// In-memory runtime: assemble a `ProtocolDeps` backed by in-process drivers (the `skein dev` runtime,
// and every adapter's `{ config }` convenience path).
export { loadInMemoryRuntime, loadReloadableInMemoryRuntime } from "./in-memory-runtime.js";
export type {
  InMemoryRuntimeConfig,
  ReloadableInMemoryRuntime,
  DevStateSnapshot,
} from "./in-memory-runtime.js";

// In-code embedding: build a `ProtocolDeps` around a compiled graph (or map of them) you already hold —
// no `langgraph.json`, no CLI — then pass `{ deps }` to any adapter. See docs/embedding.md. The graph
// types are re-exported so callers can type their map from this one package.
export {
  embedInMemoryGraphs,
  createInMemoryDeps,
  graphMapToResolver,
  normalizeEmbeddableGraphs,
} from "./in-memory-deps.js";
export type { EmbeddableGraph } from "./in-memory-deps.js";
export type {
  GraphResolver,
  ResolvedGraph,
  CompiledGraphFactory,
  ProtocolDeps,
} from "@skein-js/agent-protocol";

// Importing an existing LangGraph in-memory dev state (`.langgraph_api/`) lives at
// `@skein-js/server-kit/dev`, not here — it pulls in `superjson` and `node:fs/promises`, which every
// adapter would then carry for a path only the CLI takes. The three *functions* are deliberately not
// re-exported: that would be a static import again, defeating the split.
//
// The type is, though. A `export type` is erased at build time, so it costs nothing in the bundle — and
// removing it would break anyone naming the shape without buying anything back.
export type { DevStateCounts } from "./langgraph-import.js";

// LangGraph-compatible CORS: map a langgraph.json `http.cors` block to `cors` options. `CorsOptions`
// is re-exported so adapters can type their `cors` option without depending on the `cors` package
// directly (Fastify/NestJS/Next.js use their own CORS mechanisms but accept this shared shape).
export { corsFromHttpConfig, toCorsOptions } from "./cors-config.js";
export type { LanggraphCorsConfig } from "./cors-config.js";
export type { CorsOptions } from "cors";

// Runtime CORS helpers for adapters without a CORS middleware (NestJS middleware, Next.js handlers):
// origin resolution + response/preflight headers, with an unset origin resolving to `*` (never a
// credentialed reflected origin) and full-string-anchored regex matching.
export {
  allowedOrigin,
  joinList,
  corsResponseHeaders,
  corsPreflightHeaders,
  applyNodeCors,
  sendNodePreflight,
} from "./cors-runtime.js";
export type { CorsSetting } from "./cors-runtime.js";

// Node-`http` transport shared by the NestJS + Next.js Pages Router adapters.
export { sendNodeResponse, sendNodeError } from "./node-transport.js";

// Mount-prefix stripping for adapters that mount a catch-all and match the route table by hand
// (NestJS middleware, Next.js handlers) — `null` means "not under the mount, pass it through".
export { stripBasePath } from "./base-path.js";
