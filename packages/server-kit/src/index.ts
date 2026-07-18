// @skein-js/server-kit — the framework-agnostic building blocks every skein-js HTTP adapter shares,
// so no adapter has to depend on another (or on Express) to reuse them: the in-memory dev runtime
// assembler, the LangGraph `.langgraph_api/` dev-state importer, the langgraph.json `http.cors` →
// `CorsOptions` mapping, the runtime CORS helpers, and the Node-`http` transport (SSE/JSON/error
// serialization) the two Node-based adapters (NestJS, Next.js Pages Router) share. The route table
// itself lives with the engine in @skein-js/agent-protocol (`skeinRoutes`); each framework adapter
// still maps it onto its own router. See docs/building-an-adapter.md.

// Runtime resolution: turn a `{ config } | { deps }` option bag into a live runtime (assistants
// seeded, worker started) — the shared step every adapter runs before mounting the route table.
export { resolveProtocolRuntime } from "./resolve-runtime.js";
export type {
  SkeinRuntimeCommonOptions,
  SkeinRuntimeOptions,
  ResolvedProtocolRuntime,
} from "./resolve-runtime.js";

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
export { embedInMemoryGraphs, createInMemoryDeps, graphMapToResolver } from "./in-memory-deps.js";
export type { EmbeddableGraph } from "./in-memory-deps.js";
export type {
  GraphResolver,
  ResolvedGraph,
  CompiledGraphFactory,
  ProtocolDeps,
} from "@skein-js/agent-protocol";

// Import an existing LangGraph in-memory dev state (`.langgraph_api/`) into skein, losslessly.
export {
  readLanggraphDevState,
  loadSnapshotIntoStore,
  describeSnapshot,
} from "./langgraph-import.js";
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
