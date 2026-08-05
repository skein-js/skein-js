# @skein-js/otel

[![npm](https://img.shields.io/npm/v/%40skein-js%2Fotel?logo=npm&color=cb3837)](https://www.npmjs.com/package/@skein-js/otel)&nbsp;[![downloads](https://img.shields.io/npm/dm/%40skein-js%2Fotel?color=blue)](https://www.npmjs.com/package/@skein-js/otel)&nbsp;[![license](https://img.shields.io/npm/l/%40skein-js%2Fotel?color=green)](../../LICENSE)

> OpenTelemetry spans and metrics for skein-js runs — works with any OTLP backend.

Part of **[skein-js](../../README.md)** — the open-source alternative to LangGraph Platform for TypeScript: a self-hosted [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

## What's here

One `skein.run` span per run, plus a run counter and a duration histogram.

This package depends on the OpenTelemetry **API only** — never the SDK, never an exporter. That is
the whole reason one small package covers **Datadog, Grafana, Honeycomb, Jaeger, New Relic, Sentry**
and anything else that speaks OTLP: your app owns the SDK, the resource, and where data goes, exactly
as it already does for the rest of your service. skein just contributes spans and metrics to it.

If no SDK is registered, the API's no-op implementation takes over and this costs almost nothing.

## Install

```bash
pnpm add @skein-js/otel @opentelemetry/api
```

You also need an OTel SDK in your app (`@opentelemetry/sdk-node` or a vendor distribution) — that's
what actually exports the data.

## Usage

```ts
import { createOtelTelemetry } from "@skein-js/otel";
import { embedInMemoryGraphs } from "@skein-js/server-kit";
import { createExpressServer } from "@skein-js/express";

const server = await createExpressServer({
  deps: embedInMemoryGraphs({ agent }, { overrides: { telemetry: createOtelTelemetry() } }),
});
```

Unlike the LangSmith and PostHog sinks this never returns `undefined`: there is nothing to configure.
Whether anything is _recorded_ is decided by whether your host registered an SDK.

Using the CLI? Declare it in `langgraph.json` instead:

```json
{ "telemetry": { "otel": true } }
```

See [docs/observability.md](../../docs/observability.md).

## What it emits

**Span** `skein.run <graph_id>`, from the moment a run starts executing to the moment it settles:

| Attribute                                                                |                                              |
| ------------------------------------------------------------------------ | -------------------------------------------- |
| `skein.run.id` · `skein.thread.id` · `skein.assistant.id`                | identity                                     |
| `skein.graph.id` · `skein.run.trigger` · `skein.run.status`              | what ran, how it started, how it ended       |
| `skein.run.queue_ms` · `skein.run.frames`                                | queue wait (background runs), frames emitted |
| `skein.run.failing_nodes`                                                | the node(s) that threw, when identifiable    |
| `gen_ai.operation.name` · `gen_ai.agent.name` · `gen_ai.conversation.id` | GenAI semconv equivalents                    |

A failed run records the exception (stack and `cause` chain intact) and sets an `ERROR` status.

**Metrics** — `skein.runs` (counter) and `skein.run.duration` (histogram, ms), both dimensioned by
graph, trigger, and status. Deliberately **low-cardinality**: no run, thread, or user id, so these
stay cheap in Prometheus and friends.

## Spans inside the graph

skein reports the _run_. For LLM- and tool-level spans, add a LangChain instrumentation —
[`@traceloop/node-server-sdk`](https://github.com/traceloop/openllmetry-js) or
[`@arizeai/openinference-instrumentation-langchain`](https://github.com/Arize-ai/openinference).

Those spans are **correlated with** the run span, not **nested under** it. Nesting would need the run
span to be _active_ in the OTel context for the whole of the graph's execution, and the sink seam is
a pair of one-shot notifications with no way to hold a context open between them. Join on
`skein.run.id` or `gen_ai.conversation.id` and you get the same grouping in a query — but you won't
see generations indented under the run in a trace waterfall.

## API

- **`createOtelTelemetry(options?): TelemetrySink`** — always returns a sink.
  - `scopeName` / `scopeVersion` — instrumentation scope; defaults to `"@skein-js/otel"`
  - `metrics` — emit the counter and histogram (default `true`)
  - `api` — a pre-resolved `{ tracer, meter }`, to pick a specific provider or capture spans in tests

## Learn more

- [Observability](../../docs/observability.md) — traces, metrics, and writing your own sink
- [Errors & logging](../../docs/errors-and-logging.md) — the other two reporting surfaces
- [skein-js overview](../../docs/index.md)

## License

[Apache-2.0](../../LICENSE)
