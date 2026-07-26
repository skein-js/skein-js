# @skein-js/langsmith

> LangSmith tracing for skein-js — run identity and thread grouping on every graph call.

Part of **[skein-js](../../README.md)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

## What's here

LangSmith's tracer already instruments everything inside your graph — every LLM call, tool, and
chain. What it **can't** know on its own is what a "run" is on your server, so without help every run
lands in LangSmith as an anonymous root trace: no thread, no assistant, no user.

This package supplies that identity. Above all it sets **`session_id`**, the key LangSmith's
**Threads** view groups on — so a conversation reads as one thread in LangSmith exactly as it does
through the Agent Protocol.

It deliberately does **not** attach a tracer of its own. `@langchain/core` already installs a global
tracer when `LANGSMITH_TRACING` is on; adding a second would send every span twice — you'd pay double
and couldn't trust the numbers. Instead this sink makes sure that one tracer is switched on and
properly configured, then enriches what it sends.

## Install

```bash
pnpm add @skein-js/langsmith langsmith
```

`langsmith` and `@langchain/core` are optional peers — `@langchain/core` you already have via
LangGraph.

## Usage

Set `LANGSMITH_API_KEY` and you're done — the sink reads it, switches tracing on, and enriches every
run:

```ts
import { createLangSmithTelemetry } from "@skein-js/langsmith";
import { embedInMemoryGraphs } from "@skein-js/server-kit";
import { createExpressServer } from "@skein-js/express";

const telemetry = createLangSmithTelemetry();
const server = await createExpressServer({
  deps: embedInMemoryGraphs({ agent }, { overrides: telemetry ? { telemetry } : {} }),
});
```

`createLangSmithTelemetry()` returns `undefined` when LangSmith isn't configured, so the ternary above
is the whole "is it enabled" story.

Using the CLI? Don't write any of this — declare it in `langgraph.json` and `skein dev` / `skein start`
wire it up:

```json
{ "telemetry": { "langsmith": true } }
```

With `LANGSMITH_API_KEY` set, even that is optional: the adapter is auto-detected. See
[docs/observability.md](../../docs/observability.md).

## What lands in LangSmith

| Where      | What                                                                                 |
| ---------- | ------------------------------------------------------------------------------------ |
| `metadata` | `session_id` (= thread id), `run_id`, `thread_id`, `assistant_id`, `graph_id`        |
| `metadata` | `ls_user_id` when auth is configured, `skein_trigger` (`wait`/`stream`/`background`) |
| `tags`     | `skein`, `graph:<id>`, `trigger:<how>`, `assistant:<id>`                             |
| Run name   | the graph id                                                                         |

## API

- **`createLangSmithTelemetry(options?): TelemetrySink | undefined`** — returns `undefined` when
  LangSmith is not configured (no API key and no explicit `projectName`), so the result can be passed
  straight through.
  - `apiKey` — defaults to `LANGSMITH_API_KEY` / `LANGCHAIN_API_KEY`
  - `projectName` — defaults to `LANGSMITH_PROJECT` / `LANGCHAIN_PROJECT`
  - `endpoint` — defaults to `LANGSMITH_ENDPOINT`, for self-hosted LangSmith
  - `enableTracing` — whether to switch the global tracer on when it isn't already (default `true`).
    Existing environment values are never overwritten, so a deliberate `LANGSMITH_TRACING=false`
    is respected.
  - `env` — the environment to read and write; defaults to `process.env`.

## Learn more

- [Observability](../../docs/observability.md) — traces, metrics, and writing your own sink
- [Errors & logging](../../docs/errors-and-logging.md) — the other two reporting surfaces
- [skein-js overview](../../docs/index.md)

## License

[Apache-2.0](../../LICENSE)
