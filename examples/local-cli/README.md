# Dayplan — a daily planning assistant in your terminal

Give Dayplan a local Markdown task inbox. The selected model reads that file and previous saved plans through
tools, proposes focus blocks, explains priorities and flags what can wait. You review the plan
before the app writes anything. The original task inbox is never edited.

## Run it

Use Node 22/24 and configure whichever provider you have:

```sh
pnpm install
# Choose one provider in your environment or a private env file:
# MODEL_PROVIDER=gemini with GOOGLE_API_KEY (or GEMINI_API_KEY)
# MODEL_PROVIDER=openai with OPENAI_API_KEY
# MODEL_PROVIDER=anthropic with ANTHROPIC_API_KEY
# MODEL_PROVIDER=ollama with optional OLLAMA_BASE_URL and OLLAMA_MODEL
# MODEL_PROVIDER=vertex with Google ADC and optional GOOGLE_CLOUD_PROJECT
pnpm nx run example-local-cli:start
```

For Vertex, sign in with `gcloud auth application-default login`. The project can be discovered from
gcloud or supplied as `GOOGLE_CLOUD_PROJECT`; no project is hardcoded. `GOOGLE_CLOUD_LOCATION`
defaults to `global`. `MODEL_NAME` overrides the model (`gemini-3-flash-preview` for Google,
`gpt-5-mini` for OpenAI, `claude-sonnet-5-5` for Anthropic and `qwen3:8b` for Ollama). Provider-specific `GOOGLE_MODEL`, `OPENAI_MODEL`, `ANTHROPIC_MODEL` and `OLLAMA_MODEL` also work.
Cloud providers need valid credentials and available billing/quota.

To load a private env file based on `examples/local-workflow/.env.example`:

```sh
pnpm nx run example-local-cli:start --args="--env-file ./examples/local-workflow/.env"
```

The first run creates a sample task inbox at `.skein/dayplan/tasks.md`. Use your own file instead:

```sh
pnpm nx run example-local-cli:start --args='--tasks ./tasks.md --request "Plan a focused morning with time for interruptions."'
```

Task contents and the context returned by tools are sent to the selected provider. At the prompt choose **yes**
to save, **skip** to discard, or **later** to leave the review pending. A non-interactive run prints a
resume command. Resume after exiting, with `--approve` or `--discard` for an explicit decision:

```sh
pnpm nx run example-local-cli:start --args="--resume <thread-id> --approve"
```

SQLite state lives in `.skein/dayplan`; approved Markdown plans go into its `daily-plans/` directory.
Set `SKEIN_EXAMPLE_DATA` to select another location and use the same location when resuming.

## What to learn from it

`buildDailyPlanner` is a normal LangGraph graph: prepare → model/tools → interrupt → save.
`read_task_inbox` accesses only the host-selected file; `read_previous_plans` uses Skein's persistent
store. `@skein-js/local` supplies SQLite and the upstream checkpointer; `createProtocolRuntime`
provides the same service used behind server adapters. The CLI calls that service directly.

Skein owns persistence and attempt failure accounting. The app owns terminal interaction,
file access, model configuration, approval and retry decisions. The same embedding can be hosted
in a separate daemon with an existing transport adapter.

```sh
pnpm nx run example-local-cli:smoke
```

This explicit deterministic fixture verifies planner approval and saving, plus the ordinary
Express/SDK integration, background runs, SSE, checkpoint branching and bearer authentication.
Normal launches use the real model; there is no canned-response fallback.

For Ollama, start the server and install a model that supports tools, for example
`ollama pull qwen3:8b`. The default endpoint is `http://127.0.0.1:11434`; no API key is needed.
The app does not install or download models.
