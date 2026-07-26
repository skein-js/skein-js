// @skein-js/otel — OpenTelemetry spans and metrics for skein-js runs.
//
// Depends on the OTel **API only**, never the SDK or an exporter, which is why one package covers
// Datadog, Grafana, Honeycomb, Jaeger, New Relic, Sentry, and anything else speaking OTLP: the host
// owns the SDK and decides where data goes. See docs/observability.md.

export { createOtelTelemetry } from "./otel-telemetry.js";
export type { OtelApiLike, OtelTelemetryOptions } from "./otel-telemetry.js";

// The sink contract this package implements, re-exported so a consumer needs only this package to
// type a `ProtocolDeps.telemetry` value.
export type { TelemetrySink } from "@skein-js/core";
