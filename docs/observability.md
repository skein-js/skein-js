# Observability

How to see what your agents are doing in production — traces in LangSmith or Langfuse, metrics and
spans in OpenTelemetry, product analytics in PostHog — and how to write a sink for anything else.

For **logs** and what happens when a graph throws, see
[errors-and-logging.md](./errors-and-logging.md). This doc is about the other two surfaces.

## Contents

- [Three surfaces](#three-surfaces)
- [Turning it on](#turning-it-on)
- [LangSmith](#langsmith)
- [PostHog](#posthog)
- [OpenTelemetry](#opentelemetry)
- [Other backends](#other-backends)
- [Writing your own sink](#writing-your-own-sink)
- [Cost and safety](#cost-and-safety)

## Three surfaces

skein reports what a run did in three places, deliberately carrying different amounts of detail:

| Surface      | Who reads it      | What it gets                                                  |
| ------------ | ----------------- | ------------------------------------------------------------- |
| **The wire** | your API client   | `RunError` — a stack only when you set `exposeErrorStacks`    |
| **The log**  | you, the operator | everything: the original `Error`, its stack and `cause` chain |
| **A sink**   | you, the operator | everything, same as the log — it's server-side too            |

That last row is the rule worth remembering: **`exposeErrorStacks` governs the wire, not telemetry.**
A sink always receives the real `Error`. See [errors-and-logging.md](./errors-and-logging.md).

Telemetry itself splits in two, and one interface covers both:

- **Traces** — spans for what happens _inside_ a graph: each LLM call, tool, and chain. These come
  from LangChain's callback system, so any callback-based tracer works (LangSmith, Langfuse,
  Braintrust, OpenLLMetry).
- **Events** — the run's own lifecycle: started, settled, how long, how many frames, what failed.
  skein emits these itself, from the one code path every run mode goes through.

## Turning it on

Three ways, highest precedence first.

**1. In code** — pass a sink as `ProtocolDeps.telemetry`. Works everywhere, CLI or not:

```ts
import { createPostHogTelemetry } from "@skein-js/posthog";
import { embedInMemoryGraphs } from "@skein-js/server-kit";

const telemetry = createPostHogTelemetry();
const deps = embedInMemoryGraphs({ agent }, { overrides: telemetry ? { telemetry } : {} });
```

Each `create*Telemetry()` returns `undefined` when its backend isn't configured, so that ternary is
the whole "is it enabled" story. Pass an **array** to feed several backends at once.

**2. In `langgraph.json`** — for `skein dev` / `skein start`:

```json
{
  "graphs": { "agent": "./src/agent.ts:graph" },
  "telemetry": {
    "langsmith": true,
    "posthog": { "host": "https://eu.i.posthog.com" },
    "otel": true,
    "paths": ["./src/my-telemetry.ts:sink"]
  }
}
```

`true` enables with defaults, `false` **hard-disables** even when the environment says otherwise, and
an object is passed through to the adapter. This is a skein extension; it's additive, so a config
carrying it still loads under `langgraph dev`.

**3. From the environment** — a provider the config doesn't mention turns itself on when its
variables are present:

| Provider      | Detected from                                                                              |
| ------------- | ------------------------------------------------------------------------------------------ |
| LangSmith     | `LANGSMITH_TRACING=true` **and** `LANGSMITH_API_KEY` (or the `LANGCHAIN_` equivalents)     |
| PostHog       | `POSTHOG_API_KEY`                                                                          |
| OpenTelemetry | `OTEL_EXPORTER_OTLP_ENDPOINT` · `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` · `OTEL_SERVICE_NAME` |

With nothing configured there is no telemetry and no cost — the engine skips building any context at
all. A provider that is only _detected_ stays quietly off when it can't be built — its package isn't
installed, or its API key is absent. One you **declared** in `langgraph.json` instead **fails at
startup**, naming what is missing, because a silent no-op for something you explicitly asked for is
worse: the first you'd hear of it is an incident with no traces to investigate. Remove the entry to run
without it.

> **Why LangSmith needs two variables.** Turning tracing on uploads every prompt, tool argument, and
> model response — your users' messages — to a third party. A stray `LANGSMITH_API_KEY` (common in
> environments that use LangSmith for something else) is not consent for that. `LANGSMITH_TRACING=true`
> is LangChain's own opt-in, so that is the signal skein takes; declaring `telemetry.langsmith` in
> `langgraph.json` is the other way to say yes.

> **Building an image?** `skein build` can't see a dynamically imported adapter, so declare the
> provider in `langgraph.json` and it gets pinned into the image. Environment-detected providers are
> deliberately **not** pinned: the build machine's environment isn't the runtime's.

## LangSmith

```bash
pnpm add @skein-js/langsmith langsmith
export LANGSMITH_API_KEY=lsv2_pt_...
export LANGSMITH_TRACING=true
```

Both variables, deliberately — see the note above. Declaring `{"telemetry": {"langsmith": true}}` in
`langgraph.json` switches tracing on for you, so the key alone is enough on that path.

**What this actually fixes.** LangSmith's tracer already instruments everything inside your graph.
What it can't know is what a "run" is on your server, so without help every run lands as an anonymous
root trace: no thread, no assistant, no user. This adapter supplies that identity — above all
**`session_id`**, the key LangSmith's **Threads** view groups on, so a conversation reads as one
thread there just as it does through the Agent Protocol.

It deliberately attaches **no tracer of its own**. `@langchain/core` installs a global tracer when
`LANGSMITH_TRACING` is on; a second one would send every span twice — you'd pay double and couldn't
trust the numbers. The adapter enriches that one tracer instead.

Credentials are **read from the environment, never written to it**: skein will not copy an API key
into `process.env`, where every module and every child process would inherit it. Set
`LANGSMITH_API_KEY` (and `LANGSMITH_ENDPOINT` for self-hosted) in the environment — that is where
LangChain's tracer reads them from.

| Set on every trace |                                                                             |
| ------------------ | --------------------------------------------------------------------------- |
| `metadata`         | `session_id` (thread id), `run_id`, `thread_id`, `assistant_id`, `graph_id` |
| `metadata`         | `ls_user_id` when auth is on, `skein_trigger`                               |
| `tags`             | `skein`, `graph:<id>`, `trigger:<how>`, `assistant:<id>`                    |
| run name           | the graph id                                                                |

Full options in the [package README](../packages/telemetry-langsmith/README.md).

## PostHog

```bash
pnpm add @skein-js/posthog posthog-node
export POSTHOG_API_KEY=phc_...
```

Two layers, correlated by `$ai_trace_id` (= skein's run id):

- **`skein_run_started` / `skein_run_finished`** — status, duration, queue wait, frame count, and the
  graph, assistant, and thread. The operational picture.
- **`$ai_generation`** — PostHog's LLM Analytics schema, per model call: `$ai_model`, `$ai_provider`,
  input/output/total tokens, `$ai_latency`, `$ai_is_error`. This is what fills PostHog's LLM
  dashboards — cost per user, tokens per conversation.

Token counts come from the message's `usage_metadata` where the provider supplies it, falling back to
the older `llmOutput.tokenUsage`. When neither is present the token fields are **omitted** rather
than reported as zero — a missing number is more honest than a wrong one.

Runs are attributed to the authenticated user's identity, falling back to the thread id so anonymous
traffic groups per conversation instead of collapsing into one distinct id. Override with
`distinctId`. Turn the LLM layer off with `captureGenerations: false`. See the
[package README](../packages/telemetry-posthog/README.md).

## OpenTelemetry

```bash
pnpm add @skein-js/otel @opentelemetry/api
```

`@skein-js/otel` depends on the OTel **API only** — never the SDK, never an exporter. Your app owns
the SDK and decides where data goes, exactly as it already does for the rest of your service. That's
why one small package covers every OTLP backend. If no SDK is registered, the API's no-op
implementation takes over and this costs almost nothing.

**Span** `skein.run <graph_id>`, one per run, with `skein.run.id` / `.thread.id` / `.assistant.id` /
`.graph.id` / `.trigger` / `.status` / `.queue_ms` / `.frames` / `.failing_nodes`, plus the
`gen_ai.*` semconv equivalents. A failure records the exception and sets an `ERROR` status.

**Metrics** `skein.runs` (counter), `skein.run.duration` (histogram, ms),
`skein.run.queue.duration` (histogram, ms), and `skein.run.frames` (histogram), dimensioned by graph,
trigger, and status — deliberately **low-cardinality**, with no run, thread, or user id, so they stay
cheap in Prometheus and friends.

### Spans inside the graph

skein reports the _run_. For LLM- and tool-level spans, add a LangChain instrumentation —
[`@traceloop/node-server-sdk`](https://github.com/traceloop/openllmetry-js) or
[`@arizeai/openinference-instrumentation-langchain`](https://github.com/Arize-ai/openinference).

The OTel sink makes the Skein run span active while LangGraph executes. Instrumentation that respects
the OTel context therefore nests model, tool, and chain spans under the run span, including across
awaits; the run and thread attributes remain available for correlation and filtering too.

### Datadog, Grafana, Honeycomb, Jaeger, New Relic, Sentry

All of these are the OTel adapter plus their own exporter — no skein-specific code. Configure the SDK
the way that vendor documents, then:

```json
{ "telemetry": { "otel": true } }
```

For most, exporting `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` at their collector
is the entire integration.

## Other backends

### Langfuse

Langfuse ships a LangChain callback handler, so it needs only a small sink:

```ts
import { CallbackHandler } from "langfuse-langchain";
import type { TelemetrySink } from "@skein-js/core";

export const sink: TelemetrySink = {
  name: "langfuse",
  callbacks: (context) => [
    new CallbackHandler({
      sessionId: context.threadId, // groups a conversation in Langfuse
      userId: context.userId,
      metadata: { run_id: context.runId, graph_id: context.graphId },
    }),
  ],
};
```

```json
{ "telemetry": { "paths": ["./src/langfuse.ts:sink"] } }
```

### Braintrust

Same shape — Braintrust's LangChain handler in `callbacks`, with the thread id as the span's parent
identifier.

### Sentry

Sentry reads OTel spans, so `@skein-js/otel` plus Sentry's SDK covers tracing. For error _events_
specifically, a lifecycle sink is more direct:

```ts
import * as Sentry from "@sentry/node";
import type { TelemetrySink } from "@skein-js/core";

export const sink: TelemetrySink = {
  name: "sentry",
  onRunEvent: (event) => {
    if (event.type !== "run.finished" || !event.cause) return;
    // `event.cause` is the original Error — stack and cause chain intact.
    Sentry.captureException(event.cause, {
      tags: { graph_id: event.context.graphId, status: event.status },
      contexts: { skein: { run_id: event.context.runId, thread_id: event.context.threadId } },
    });
  },
};
```

### Your existing logger

A sink is the right seam for feeding **run lifecycle events** into your logs. If you only want skein's
own reports — failed runs, webhook failures — that is `ProtocolDeps.logger`, and under NestJS and
Fastify it is already wired to the host's logger by default. See
[errors-and-logging.md](./errors-and-logging.md#logging).

If you already ship structured logs somewhere, a sink is a ten-line bridge:

```ts
export const sink: TelemetrySink = {
  name: "logger",
  onRunEvent: (event) =>
    logger.info(event.type, {
      ...event.context,
      ...(event.type === "run.finished" && {
        status: event.status,
        duration_ms: event.durationMs,
      }),
    }),
};
```

## Writing your own sink

The whole interface, from `@skein-js/core`. Every method is optional — implement the half you need:

```ts
export interface TelemetrySink {
  name: string;
  /** Run lifecycle. Fire-and-forget: never awaited. */
  onRunEvent?(event: RunTelemetryEvent): void;
  /** LangChain callback handlers, so a tracer's spans nest under the run. */
  callbacks?(context: RunTelemetryContext): unknown[];
  /** Extra metadata / tags stamped on the graph call. */
  traceMetadata?(context: RunTelemetryContext): Record<string, unknown>;
  traceTags?(context: RunTelemetryContext): string[];
  /** Make a backend context active while the graph executes. */
  withRunContext?<T>(context: RunTelemetryContext, body: () => Promise<T>): Promise<T>;
  /** Drain buffered data — called on shutdown. */
  flush?(): Promise<void>;
  shutdown?(): Promise<void>;
}
```

`RunTelemetryContext` carries `runId`, `threadId`, `assistantId`, `graphId`, `userId`, `trigger`
(`wait` / `stream` / `background` / `invoke`), `streamModes`, and the run's `metadata`.

`run.finished` adds `status`, `durationMs`, `frameCount`, and on failure `error` (the JSON-safe
`RunError`), `failingNodes` (which graph node threw), and `cause` (the original `Error`).

Two things to know:

- **`assistantId` is absent for `trigger: "invoke"`.** The `POST /invoke/:graph_id` surface addresses
  a graph directly, with no assistant in between. It emits lifecycle telemetry using a synthetic run
  identity for correlation, but deliberately creates no persistent run row.
- **Sinks may not throw or block.** Every call is guarded, so a throw is logged and swallowed rather
  than failing a run — but a sink doing inline I/O still slows every run it observes. Buffer, and
  implement `flush()`; skein calls it on shutdown so buffering is the safe default.

Point `langgraph.json` at it:

```json
{ "telemetry": { "paths": ["./src/my-telemetry.ts:sink"] } }
```

The export may be the sink itself or a function returning one, so your module can read its own
configuration.

## Cost and safety

- **Off by default, free when off.** With no sink configured the engine builds no context and reads
  no metadata. There is no "disabled telemetry" tax.
- **A broken sink can't break a run.** Every method is wrapped; a throw is logged through
  `ProtocolDeps.logger` and dropped. One sink failing doesn't stop the others.
- **Flushed on shutdown.** The run worker and the runtime both drain sinks when stopping, so batching
  exporters don't lose the tail of a process — which is exactly the telemetry you want after a crash.
- **Metric cardinality.** skein's own OTel metrics carry no run, thread, or user id. If you write a
  sink, resist adding them as metric dimensions — they belong on spans and events, not counters.
- **What leaves your server.** Traces carry your graph's inputs and outputs, which for an agent means
  user messages. Check that against your data-handling obligations before pointing them at a hosted
  backend; self-hosted LangSmith, Langfuse, and any OTLP collector are all supported.

## Learn more

- [Errors & logging](./errors-and-logging.md) — the other two reporting surfaces
- [Runs & Redis](./runs-and-redis.md) — the run engine these events come from
- [Deploy](./deploy.md) — running skein in production
