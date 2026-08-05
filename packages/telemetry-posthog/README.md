# @skein-js/posthog

[![npm](https://img.shields.io/npm/v/%40skein-js%2Fposthog?logo=npm&color=cb3837)](https://www.npmjs.com/package/@skein-js/posthog)&nbsp;[![downloads](https://img.shields.io/npm/dm/%40skein-js%2Fposthog?color=blue)](https://www.npmjs.com/package/@skein-js/posthog)&nbsp;[![license](https://img.shields.io/npm/l/%40skein-js%2Fposthog?color=green)](../../LICENSE)

> PostHog analytics for skein-js — run lifecycle events plus `$ai_generation` LLM analytics.

Part of **[skein-js](../../README.md)** — the open-source alternative to LangGraph Platform for TypeScript: a self-hosted [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

## What's here

Two layers, because PostHog answers two different questions:

- **Run lifecycle** — `skein_run_started` / `skein_run_finished`, carrying status, duration, queue
  wait, frame count, and the graph, assistant, and thread it belongs to. The operational picture: how
  often runs fail, how long they take, which graph is slow.
- **LLM analytics** — PostHog's **`$ai_generation`** schema, emitted per model call with token counts,
  latency, model, and provider. This is what populates PostHog's LLM Analytics dashboards — cost per
  user, tokens per conversation, which model is being called.

skein can't see token usage from the run engine (it exists only inside LangChain's callbacks), so the
second layer is a callback handler. Both are correlated by **`$ai_trace_id`**, which is skein's run
id — so any generation traces back to the run and thread that produced it.

## Install

```bash
pnpm add @skein-js/posthog posthog-node
```

`posthog-node` is an optional peer, resolved at runtime.

## Usage

Set `POSTHOG_API_KEY` and you're done:

```ts
import { createPostHogTelemetry } from "@skein-js/posthog";
import { embedInMemoryGraphs } from "@skein-js/server-kit";
import { createExpressServer } from "@skein-js/express";

const telemetry = createPostHogTelemetry();
const server = await createExpressServer({
  deps: embedInMemoryGraphs({ agent }, { overrides: telemetry ? { telemetry } : {} }),
});
```

`createPostHogTelemetry()` returns `undefined` when PostHog isn't configured, so the ternary above is
the whole "is it enabled" story.

Using the CLI? Declare it in `langgraph.json` instead and `skein dev` / `skein start` wire it up:

```json
{ "telemetry": { "posthog": { "host": "https://eu.i.posthog.com" } } }
```

See [docs/observability.md](../../docs/observability.md).

## Events

**`skein_run_started`** — `run_id`, `thread_id`, `assistant_id`, `graph_id`, `trigger`,
`stream_modes`, `queue_ms` (background runs).

**`skein_run_finished`** — the same identity plus `status`, `duration_ms`, `frame_count`, `is_error`,
and on failure `error_name`, `error_message`, `failing_nodes`.

**`$ai_generation`** — `$ai_trace_id` (the run id), `$ai_span_id`, `$ai_model`, `$ai_provider`,
`$ai_input_tokens`, `$ai_output_tokens`, `$ai_total_tokens`, `$ai_latency` (seconds), `$ai_is_error`,
`$ai_error`. Token counts are read from the message's `usage_metadata` where the provider supplies it,
falling back to the older `llmOutput.tokenUsage`; when neither is present the token fields are
**omitted** rather than reported as zero.

Runs are attributed to the authenticated user's identity, falling back to the thread id so anonymous
traffic still groups per conversation instead of collapsing into a single distinct id.

## API

- **`createPostHogTelemetry(options?): TelemetrySink | undefined`** — `undefined` when PostHog is not
  configured (no `POSTHOG_API_KEY` and no injected `client`).
  - `apiKey` — defaults to `POSTHOG_API_KEY`
  - `host` — defaults to `POSTHOG_HOST`, then `https://us.i.posthog.com`
  - `captureGenerations` — emit `$ai_generation` events (default `true`). Off gives run lifecycle only.
  - `distinctId(context)` — who a run is attributed to; defaults to `userId ?? threadId`
  - `client` — a pre-built PostHog client, to control batching or to capture events in tests
  - `env` — the environment to read; defaults to `process.env`

`flush()` and `shutdown()` are called for you on runtime shutdown — without them PostHog's batching
would drop the tail of every process.

## Learn more

- [Observability](../../docs/observability.md) — traces, metrics, and writing your own sink
- [Errors & logging](../../docs/errors-and-logging.md) — the other two reporting surfaces
- [skein-js overview](../../docs/index.md)

## License

[Apache-2.0](../../LICENSE)
