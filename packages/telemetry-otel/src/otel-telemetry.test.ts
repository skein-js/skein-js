import type { RunTelemetryContext, RunTelemetryEvent } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { createOtelTelemetry, type OtelApiLike } from "./otel-telemetry.js";

const context: RunTelemetryContext = {
  runId: "run-1",
  threadId: "thread-1",
  assistantId: "assistant-1",
  graphId: "agent",
  trigger: "background",
  streamModes: ["values"],
};

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  exceptions: Error[];
  ended: boolean;
  endTime?: Date;
  startTime?: Date;
}

interface RecordedMetric {
  instrument: string;
  value: number;
  attributes?: Record<string, unknown>;
}

/** An in-memory stand-in for the OTel API — no SDK, no exporter, no network. */
function fakeApi(): OtelApiLike & { spans: RecordedSpan[]; metrics: RecordedMetric[] } {
  const spans: RecordedSpan[] = [];
  const metrics: RecordedMetric[] = [];
  return {
    spans,
    metrics,
    tracer: {
      startSpan(name, options) {
        const span: RecordedSpan = {
          name,
          attributes: { ...options?.attributes },
          exceptions: [],
          ended: false,
          ...(options?.startTime ? { startTime: options.startTime } : {}),
        };
        spans.push(span);
        return {
          setAttribute: (key, value) => (span.attributes[key] = value),
          setStatus: (status) => (span.status = status),
          recordException: (error) => span.exceptions.push(error),
          end: (endTime) => {
            span.ended = true;
            if (endTime) span.endTime = endTime;
          },
        };
      },
    },
    meter: {
      createCounter: (instrument) => ({
        add: (value, attributes) =>
          metrics.push({ instrument, value, ...(attributes ? { attributes } : {}) }),
      }),
      createHistogram: (instrument) => ({
        record: (value, attributes) =>
          metrics.push({ instrument, value, ...(attributes ? { attributes } : {}) }),
      }),
    },
  };
}

const startedAt = new Date("2026-07-26T00:00:00.000Z");
const endedAt = new Date("2026-07-26T00:00:02.000Z");

const started: RunTelemetryEvent = { type: "run.started", context, startedAt, queuedMs: 300 };

const finished = (
  overrides: Partial<Extract<RunTelemetryEvent, { type: "run.finished" }>> = {},
): RunTelemetryEvent =>
  ({
    type: "run.finished",
    context,
    status: "success",
    durationMs: 2000,
    frameCount: 4,
    endedAt,
    ...overrides,
  }) as RunTelemetryEvent;

describe("createOtelTelemetry", () => {
  it("opens a span on start, carrying run identity and queue latency", () => {
    const api = fakeApi();
    createOtelTelemetry({ api }).onRunEvent?.(started);

    expect(api.spans).toHaveLength(1);
    expect(api.spans[0]).toMatchObject({
      name: "skein.run agent",
      startTime: startedAt,
      ended: false,
    });
    expect(api.spans[0]?.attributes).toMatchObject({
      "skein.run.id": "run-1",
      "skein.thread.id": "thread-1",
      "skein.assistant.id": "assistant-1",
      "skein.graph.id": "agent",
      "skein.run.trigger": "background",
      "skein.run.queue_ms": 300,
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.conversation.id": "thread-1",
    });
  });

  it("closes the span on finish, with an OK status and the frame count", () => {
    const api = fakeApi();
    const sink = createOtelTelemetry({ api });
    sink.onRunEvent?.(started);
    sink.onRunEvent?.(finished());

    expect(api.spans[0]).toMatchObject({ ended: true, endTime: endedAt, status: { code: 1 } });
    expect(api.spans[0]?.attributes).toMatchObject({
      "skein.run.status": "success",
      "skein.run.frames": 4,
    });
  });

  it("records the exception and an error status for a failed run", () => {
    const api = fakeApi();
    const sink = createOtelTelemetry({ api });
    const cause = new Error("model call failed");
    sink.onRunEvent?.(started);
    sink.onRunEvent?.(
      finished({
        status: "error",
        error: { error: "Error", name: "Error", message: "model call failed" },
        cause,
        failingNodes: ["call_model"],
      }),
    );

    expect(api.spans[0]?.status).toMatchObject({ code: 2, message: "model call failed" });
    expect(api.spans[0]?.exceptions).toEqual([cause]);
    expect(api.spans[0]?.attributes).toMatchObject({ "skein.run.failing_nodes": "call_model" });
  });

  it("treats a timeout as a failed span", () => {
    const api = fakeApi();
    const sink = createOtelTelemetry({ api });
    sink.onRunEvent?.(started);
    sink.onRunEvent?.(finished({ status: "timeout" }));

    expect(api.spans[0]?.status?.code).toBe(2);
  });

  it("records a run counter and a duration histogram", () => {
    const api = fakeApi();
    const sink = createOtelTelemetry({ api });
    sink.onRunEvent?.(started);
    sink.onRunEvent?.(finished());

    expect(api.metrics).toEqual([
      {
        instrument: "skein.runs",
        value: 1,
        attributes: {
          "skein.graph.id": "agent",
          "skein.run.trigger": "background",
          "skein.run.status": "success",
        },
      },
      {
        instrument: "skein.run.duration",
        value: 2000,
        attributes: {
          "skein.graph.id": "agent",
          "skein.run.trigger": "background",
          "skein.run.status": "success",
        },
      },
    ]);
  });

  it("keeps metric dimensions low-cardinality — no run, thread, or user id", () => {
    const api = fakeApi();
    const sink = createOtelTelemetry({ api });
    sink.onRunEvent?.(started);
    sink.onRunEvent?.(finished({ context: { ...context, userId: "user-42" } }));

    for (const metric of api.metrics) {
      expect(metric.attributes).not.toHaveProperty("skein.run.id");
      expect(metric.attributes).not.toHaveProperty("skein.thread.id");
      expect(metric.attributes).not.toHaveProperty("skein.user.id");
    }
  });

  it("can record metrics without spans being wanted, and vice versa", () => {
    const api = fakeApi();
    const sink = createOtelTelemetry({ api, metrics: false });
    sink.onRunEvent?.(started);
    sink.onRunEvent?.(finished());

    expect(api.spans[0]?.ended).toBe(true);
    expect(api.metrics).toEqual([]);
  });

  it("omits assistant identity for the invoke surface, which has none", () => {
    const api = fakeApi();
    createOtelTelemetry({ api }).onRunEvent?.({
      ...started,
      context: { ...context, assistantId: undefined, trigger: "invoke" },
    } as RunTelemetryEvent);

    expect(api.spans[0]?.attributes).not.toHaveProperty("skein.assistant.id");
  });

  it("ignores a finish for a run it never saw start", () => {
    const api = fakeApi();
    // Metrics still land — they don't depend on a span — but nothing crashes on the missing span.
    expect(() => createOtelTelemetry({ api }).onRunEvent?.(finished())).not.toThrow();
    expect(api.spans).toEqual([]);
    expect(api.metrics).toHaveLength(2);
  });

  it("closes a stranded span on shutdown rather than losing it silently", async () => {
    const api = fakeApi();
    const sink = createOtelTelemetry({ api });
    sink.onRunEvent?.(started);

    await sink.shutdown?.();

    expect(api.spans[0]).toMatchObject({ ended: true, status: { code: 2 } });
  });

  it("is always configured — whether anything records is the host SDK's business", () => {
    expect(createOtelTelemetry({ api: fakeApi() })).toBeDefined();
  });

  it("buffers events emitted before @opentelemetry/api finishes importing", async () => {
    // With no `api` injected the sink resolves the global one via a dynamic import, which is not
    // synchronous. Dropping events until it lands would silently cost a cold-started process its
    // first run's span — and then its `run.finished` would find no span to close.
    const sink = createOtelTelemetry({ scopeName: "buffer-test" });

    expect(() => {
      sink.onRunEvent?.(started);
      sink.onRunEvent?.(finished());
    }).not.toThrow();

    // Let the import settle; whether it resolves to a real API depends on the package being present,
    // but either way the buffered events must not have thrown or leaked.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(sink.shutdown?.()).resolves.toBeUndefined();
  });
});
