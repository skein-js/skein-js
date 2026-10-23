import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import { expect, it } from "vitest";

import { createOtelTelemetry } from "./otel-telemetry.js";

class HostMetricReader extends MetricReader {
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

it("collects the host's instruments with official Prometheus and OTLP JSON serializers", async () => {
  const reader = new HostMetricReader();
  const provider = new MeterProvider({ readers: [reader] });
  const sink = createOtelTelemetry({
    metricReader: reader,
    api: {
      meter: provider.getMeter("test"),
      tracer: {
        startSpan: () => {
          throw new Error("unexpected span");
        },
      },
    },
  });
  try {
    sink.onHttpEvent?.({
      type: "request.finished",
      method: "POST",
      route: "createThread",
      status: 200,
      durationMs: 12,
    });
    const prometheus = await sink.collectMetrics!("prometheus");
    expect(prometheus.contentType).toContain("text/plain");
    expect(prometheus.body).toContain(
      'skein_http_requests_total{http_request_method="POST",http_route="createThread",http_response_status_code="200",otel_scope_name="test"} 1',
    );
    const json = await sink.collectMetrics!("json");
    expect(json.contentType).toBe("application/json");
    expect(JSON.parse(json.body)).toMatchObject({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: expect.arrayContaining([
                expect.objectContaining({ name: "skein.http.requests" }),
              ]),
            },
          ],
        },
      ],
    });
    await sink.shutdown?.();
    // Sink shutdown leaves the host reader alive.
    expect((await reader.collect()).errors).toEqual([]);
  } finally {
    await provider.shutdown();
  }
});

it("surfaces collection failures instead of returning partial or estimated measurements", async () => {
  const sink = createOtelTelemetry({
    metricReader: {
      collect: async () => ({ resourceMetrics: {}, errors: [new Error("collector failed")] }),
    },
  });
  await expect(sink.collectMetrics!("json")).rejects.toThrow("metric collection failed");
});
