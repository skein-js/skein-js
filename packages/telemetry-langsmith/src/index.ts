// @skein-js/langsmith — LangSmith tracing for skein-js runs.
//
// LangSmith's tracer already instruments everything inside a graph; what it can't know on its own is
// what a *run* is. This package supplies that identity — above all `session_id`, the key LangSmith's
// Threads view groups on — so a conversation reads as one thread there just as it does through the
// Agent Protocol. See docs/observability.md.

export { createLangSmithTelemetry, isLangSmithTracingEnabled } from "./langsmith-telemetry.js";
export type { LangSmithTelemetryOptions } from "./langsmith-telemetry.js";

// The sink contract this package implements, re-exported so a consumer needs only this package to
// type a `ProtocolDeps.telemetry` value.
export type { TelemetrySink } from "@skein-js/core";
