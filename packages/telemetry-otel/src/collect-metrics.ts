/** Collection is supplied by the host; serializers never create an SDK, reader or listening port. */
export async function collectOtelMetrics(
  reader: { collect(): Promise<{ resourceMetrics: unknown; errors?: unknown[] }> },
  format: "prometheus" | "json",
): Promise<{ body: string; contentType: string }> {
  const collection = await reader.collect();
  if (collection.errors?.length)
    throw new AggregateError(collection.errors, "OpenTelemetry metric collection failed.");
  if (format === "json") {
    const { JsonMetricsSerializer } = await import("@opentelemetry/otlp-transformer");
    const snapshot = collection.resourceMetrics as Parameters<
      typeof JsonMetricsSerializer.serializeRequest
    >[0];
    const encoded = JsonMetricsSerializer.serializeRequest(snapshot);
    if (!encoded) throw new Error("OpenTelemetry did not serialize collected metrics.");
    return { body: new TextDecoder().decode(encoded), contentType: "application/json" };
  }
  const { PrometheusSerializer } = await import("@opentelemetry/exporter-prometheus");
  const serializer = new PrometheusSerializer();
  return {
    body: serializer.serialize(
      collection.resourceMetrics as Parameters<typeof serializer.serialize>[0],
    ),
    contentType: "text/plain; version=0.0.4; charset=utf-8",
  };
}
