// @skein-js/posthog — PostHog analytics for skein-js runs.
//
// Two layers, correlated by `$ai_trace_id` (skein's run id): `skein_run_started` /
// `skein_run_finished` lifecycle events for the operational picture, and PostHog's `$ai_generation`
// schema per model call for LLM Analytics (tokens, latency, cost). See docs/observability.md.

export { createPostHogTelemetry } from "./posthog-telemetry.js";
export type { PostHogClientLike, PostHogTelemetryOptions } from "./posthog-telemetry.js";

// The sink contract this package implements, re-exported so a consumer needs only this package to
// type a `ProtocolDeps.telemetry` value.
export type { TelemetrySink } from "@skein-js/core";
