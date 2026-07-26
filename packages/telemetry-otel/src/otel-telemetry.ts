// OpenTelemetry spans and metrics for skein runs.
//
// This package depends on the OTel **API only** — never the SDK, never an exporter. That is the
// whole reason one small package covers Datadog, Grafana, Honeycomb, Jaeger, New Relic, Sentry, and
// anything else that speaks OTLP: the host owns the SDK, the resource, and where data goes, exactly
// as it already does for the rest of its service. If no SDK is registered the API's no-op
// implementation takes over and this costs almost nothing.
//
// Scope: skein reports the *run* — one `skein.run` span per run, plus a counter and a duration
// histogram. It does not instrument what happens inside the graph; for LLM- and tool-level spans,
// add a LangChain instrumentation (`@traceloop/node-server-sdk` or
// `@arizeai/openinference-instrumentation-langchain`).
//
// Those instrumentation spans are **not** children of the run span. Making them children would mean
// the run span were *active* in the OTel context for the whole of the graph's execution, which needs
// `context.with(...)` wrapped around the call — and the sink seam is a pair of one-shot
// `onRunEvent` notifications, with no way to hold a context open across them. So the run span and
// any instrumentation spans are correlated by attribute (`skein.run.id`, `gen_ai.conversation.id`)
// rather than by parentage. Query by those and you get the same grouping; expand the run span in a
// trace view and you will not see the generations underneath it.

import type { RunTelemetryContext, RunTelemetryEvent, TelemetrySink } from "@skein-js/core";

// The slices of `@opentelemetry/api` this sink uses, declared structurally. Keeping the import
// type-only means the package has no runtime dependency on the API either — a host that hasn't
// installed it still gets a working (silent) sink rather than a crash on import.
interface OtelSpan {
  setAttribute(key: string, value: string | number | boolean): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  recordException(exception: Error): unknown;
  end(endTime?: Date): void;
}

interface OtelTracer {
  startSpan(
    name: string,
    options?: { attributes?: Record<string, string | number | boolean>; startTime?: Date },
  ): OtelSpan;
}

interface OtelCounter {
  add(value: number, attributes?: Record<string, string | number | boolean>): void;
}

interface OtelHistogram {
  record(value: number, attributes?: Record<string, string | number | boolean>): void;
}

interface OtelMeter {
  createCounter(name: string, options?: { description?: string; unit?: string }): OtelCounter;
  createHistogram(name: string, options?: { description?: string; unit?: string }): OtelHistogram;
}

/** The pieces of the OTel API a caller can inject, so tests need no SDK. */
export interface OtelApiLike {
  tracer: OtelTracer;
  meter?: OtelMeter;
}

export interface OtelTelemetryOptions {
  /**
   * Instrumentation scope name, as it appears on every span and metric. Defaults to
   * `"@skein-js/otel"`; change it if you want skein's spans attributed to your own service scope.
   */
  scopeName?: string;
  /** Instrumentation scope version. */
  scopeVersion?: string;
  /** Emit the `skein.runs` counter and `skein.run.duration` histogram. On by default. */
  metrics?: boolean;
  /**
   * A pre-resolved API surface. Supply one to control which tracer/meter is used, or to capture
   * spans in tests. When omitted, `@opentelemetry/api`'s global providers are used.
   */
  api?: OtelApiLike;
}

/** `SpanStatusCode` from the OTel API, inlined so no runtime import is needed. UNSET is 0. */
const SPAN_STATUS_OK = 1;
const SPAN_STATUS_ERROR = 2;

/**
 * A ceiling on in-flight spans. `run.finished` fires from the engine's `finally`, so every span that
 * opens is closed and this should never be reached — it exists so that a future caller who emits
 * only `run.started` degrades into dropping spans rather than leaking memory without bound.
 */
const MAX_IN_FLIGHT_SPANS = 10_000;

/** Terminal statuses that mean the run did not do what it was asked. */
function isFailure(status: string): boolean {
  return status === "error" || status === "timeout";
}

/** Span/metric attributes for a run. `skein.*` for our own, `gen_ai.*` where OTel semconv maps. */
function runAttributes(context: RunTelemetryContext): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {
    "skein.run.id": context.runId,
    "skein.thread.id": context.threadId,
    "skein.graph.id": context.graphId,
    "skein.run.trigger": context.trigger,
    // The closest semconv equivalents, so a GenAI-aware backend groups skein runs with everything
    // else it already understands.
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": context.graphId,
    "gen_ai.conversation.id": context.threadId,
  };
  if (context.assistantId !== undefined) attributes["skein.assistant.id"] = context.assistantId;
  if (context.userId !== undefined) attributes["skein.user.id"] = context.userId;
  return attributes;
}

/** Metric dimensions — deliberately low-cardinality: no run, thread, or user id. */
function metricAttributes(
  context: RunTelemetryContext,
  status: string,
): Record<string, string | number | boolean> {
  return {
    "skein.graph.id": context.graphId,
    "skein.run.trigger": context.trigger,
    "skein.run.status": status,
  };
}

/** Resolve the global tracer/meter from `@opentelemetry/api`, or `undefined` if it isn't installed. */
async function loadGlobalApi(
  scopeName: string,
  scopeVersion?: string,
): Promise<OtelApiLike | undefined> {
  try {
    const otel = (await import("@opentelemetry/api")) as {
      trace: { getTracer(name: string, version?: string): OtelTracer };
      metrics?: { getMeter(name: string, version?: string): OtelMeter };
    };
    return {
      tracer: otel.trace.getTracer(scopeName, scopeVersion),
      ...(otel.metrics ? { meter: otel.metrics.getMeter(scopeName, scopeVersion) } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Build a {@link TelemetrySink} that records each run as an OpenTelemetry span, plus run-count and
 * duration metrics.
 *
 * Unlike the LangSmith and PostHog sinks this never returns `undefined`: there is nothing to
 * configure. Whether anything is *recorded* is decided by whether the host registered an OTel SDK —
 * if it didn't, the API's no-op tracer silently discards, which is the behaviour you want.
 *
 * ```ts
 * // The host sets up the SDK however it likes (NodeSDK, auto-instrumentation, a vendor distro):
 * const deps = embedInMemoryGraphs(graphs, { overrides: { telemetry: createOtelTelemetry() } });
 * ```
 */
export function createOtelTelemetry(options: OtelTelemetryOptions = {}): TelemetrySink {
  const scopeName = options.scopeName ?? "@skein-js/otel";
  const wantMetrics = options.metrics ?? true;

  let api: OtelApiLike | undefined = options.api;
  // Events that arrived before the dynamic import settled. Without this buffer the first run of a
  // process loses its `run.started`, and its `run.finished` then finds no span to close — a hole in
  // the trace exactly where a cold start is most worth looking at.
  let buffered: RunTelemetryEvent[] | undefined = api === undefined ? [] : undefined;
  const handlers: { emit(event: RunTelemetryEvent): void } = { emit: () => {} };

  if (api === undefined) {
    void loadGlobalApi(scopeName, options.scopeVersion).then((resolved) => {
      api = resolved;
      const pending = buffered ?? [];
      buffered = undefined;
      // Replay in arrival order, so a buffered start still opens the span its finish closes.
      if (resolved) for (const event of pending) handlers.emit(event);
    });
  }

  // Instruments are created once, lazily, because creating them before an SDK is registered would
  // bind them to the no-op provider for the life of the process.
  let runCounter: OtelCounter | undefined;
  let durationHistogram: OtelHistogram | undefined;
  const instruments = (meter: OtelMeter) => {
    runCounter ??= meter.createCounter("skein.runs", {
      description: "Runs that reached a terminal status, dimensioned by that status.",
    });
    durationHistogram ??= meter.createHistogram("skein.run.duration", {
      description: "How long a run took, from running to settled.",
      unit: "ms",
    });
    return { runCounter, durationHistogram };
  };

  const inFlight = new Map<string, OtelSpan>();

  handlers.emit = (event: RunTelemetryEvent): void => {
    const active = api;
    if (!active) return;

    if (event.type === "run.started") {
      if (inFlight.size >= MAX_IN_FLIGHT_SPANS) return;
      inFlight.set(
        event.context.runId,
        active.tracer.startSpan(`skein.run ${event.context.graphId}`, {
          attributes: {
            ...runAttributes(event.context),
            ...(event.queuedMs !== undefined ? { "skein.run.queue_ms": event.queuedMs } : {}),
          },
          startTime: event.startedAt,
        }),
      );
      return;
    }

    const span = inFlight.get(event.context.runId);
    inFlight.delete(event.context.runId);

    if (span) {
      span.setAttribute("skein.run.status", event.status);
      span.setAttribute("skein.run.frames", event.frameCount);
      if (event.failingNodes?.length) {
        span.setAttribute("skein.run.failing_nodes", event.failingNodes.join(","));
      }
      if (isFailure(event.status)) {
        // The original `Error` is what carries the stack — a sink is server-side, so it gets it
        // whatever `exposeErrorStacks` says.
        if (event.cause) span.recordException(event.cause);
        span.setStatus({
          code: SPAN_STATUS_ERROR,
          ...(event.error ? { message: event.error.message } : {}),
        });
      } else {
        span.setStatus({ code: SPAN_STATUS_OK });
      }
      span.end(event.endedAt);
    }

    if (wantMetrics && active.meter) {
      const { runCounter: counter, durationHistogram: histogram } = instruments(active.meter);
      const attributes = metricAttributes(event.context, event.status);
      counter.add(1, attributes);
      histogram.record(event.durationMs, attributes);
    }
  };

  return {
    name: "otel",

    onRunEvent(event: RunTelemetryEvent) {
      // Still importing `@opentelemetry/api`: hold the event rather than drop it.
      if (buffered) {
        if (buffered.length < MAX_IN_FLIGHT_SPANS) buffered.push(event);
        return;
      }
      handlers.emit(event);
    },

    async shutdown() {
      // End any span whose run never reported finishing, so shutdown doesn't strand them unsent.
      // Not an error path in practice — the engine always closes the pair — but shutdown is exactly
      // when an unclosed span would be lost silently.
      for (const span of inFlight.values()) {
        try {
          span.setStatus({ code: SPAN_STATUS_ERROR, message: "Run did not report completion." });
          span.end();
        } catch {
          // Nothing useful to do; teardown must not throw.
        }
      }
      inFlight.clear();
      // Flushing the exporter is the host's job — it owns the SDK, and calling `shutdown()` on a
      // provider we don't own would tear down telemetry for their whole service, not just ours.
    },
  };
}
