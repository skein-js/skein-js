# Recipes

Choose a task, follow its recipe, and run the linked example to compare the result with your own
project. Each recipe uses existing public APIs. For a terse API reference, see
[Using skein-js](../using-skein.md).

## Read working code first

[`triage-agent`](https://github.com/skein-js/skein-js/tree/main/examples/triage-agent) uses Gemini to
triage issues and answer questions about past decisions. It shows crons, background runs, approval,
and memory. Start with the bundled sample issues, then switch to a public GitHub repository if you
want live input.

```bash
cd examples/triage-agent
cp .env.example .env    # add your GOOGLE_API_KEY
pnpm --filter @skein-js/example-triage-agent dev    # console at http://127.0.0.1:2024/console/
pnpm --filter @skein-js/example-triage-agent seed   # register the schedule + sweep once
```

## Free API keys for testing

**Gemini.** Sign in to [Google AI Studio](https://aistudio.google.com/apikey). Accept the terms and
use the key from your default project, or select a project and choose **Create API key**. For
no-cost testing, use a project that has free-tier access and check its available quota in
[AI Studio](https://aistudio.google.com/usage). The examples generally use `gemini-3.5-flash-lite`,
which Google lists on the [Gemini API free tier](https://ai.google.dev/gemini-api/docs/pricing).
See [Google's API key setup guide](https://ai.google.dev/gemini-api/docs/api-key) for project and
key setup.

Copy the example's `.env.example` to `.env`, or copy `.env.local.example` to `.env.local` for Next.js.
Add `GOOGLE_API_KEY=your-key` and start the example's server. If the example has no env template,
set `GOOGLE_API_KEY` in the server's environment before starting it. Keep keys out of committed files
and browser-side settings. If a request returns HTTP 429, check the
[project's model and rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).

**Tavily web search (optional).** Create a [Tavily account](https://app.tavily.com/), copy a development
key from the dashboard, and set `TAVILY_API_KEY` in the chat example's `.env`. See
[Tavily's free plan](https://www.tavily.com/pricing) for the current credit allowance.

The keyless examples focus on transport, embedding, migration, or workflow mechanics. They let
you test those boundaries independently of a model provider. Automated tests inject their own
model fixtures where a predictable response is needed.

## The recipes

| Page                                                           | Covers                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Serving](./serving.md)                                        | Pick an adapter, serve a graph as a plain endpoint, CORS for a browser        |
| [Running agents](./running-agents.md)                          | Background runs, crons, idempotency, human-in-the-loop, run timeouts          |
| [Coupled WhatsApp workflow](./coupled-channel.md)              | A workflow with the same provider as source and destination                   |
| [Cross-provider workflow](./decoupled-channel-delivery.md)     | Email source → LangGraph workflow → allowlisted WhatsApp/email destinations   |
| [Memory](./memory.md)                                          | `getStore()`, semantic search, and the dedup trap                             |
| [Deep Agents](./deep-agents.md) _(experimental)_               | Files, per-user memory, streamed subagents, approval and async subagents      |
| [Human input over MCP](./mcp-human-input.md)                   | Official client form/URL questions, tool review and resumable answers         |
| [Separate API and workers](./split-api-worker.md)              | Published runtime composition, background scaling and lifecycle ownership     |
| [Streaming UI with json-render](./json-render.md)              | Catalog-driven UI generation, progressive rendering, restoration and actions  |
| [Angular UI with A2UI](./a2ui.md)                              | Native Angular surfaces, bound form actions, checkpointed review and recovery |
| [Authenticating requests](./authentication.md)                 | Better Auth, Clerk, Supabase, Firebase, OIDC/JWT, and authorization policy    |
| [Production](./production.md)                                  | Auth, run-completion webhooks, durable storage and deploying                  |
| [Deploy with Postgres and Redis](../deploy.md#pick-a-platform) | Provision both services for the standard production server on your platform   |
| [Local apps and SQLite](../local-deployment.md)                | Desktop, CLI, and daemon hosts with one owned database file                   |

## Which example shows what

| Example                                                                                            | Shows                                                                                    |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`triage-agent`](https://github.com/skein-js/skein-js/tree/main/examples/triage-agent)             | Crons, background runs, idempotency, HITL, memory, time travel                           |
| [`decoupled-delivery`](https://github.com/skein-js/skein-js/tree/main/examples/decoupled-delivery) | Routed channels: email source → approval workflow → WhatsApp/email destinations          |
| [`chat-app`](https://github.com/skein-js/skein-js/tree/main/examples/chat-app)                     | Full-stack chat: streaming, thinking, tool cards, HITL, memory                           |
| [`json-render`](https://github.com/skein-js/skein-js/tree/main/examples/json-render)               | React UI playground: streamed JSON UI, saved specs, revisions and approval               |
| [`a2ui`](https://github.com/skein-js/skein-js/tree/main/examples/a2ui)                             | Angular UI playground: A2UI 1.0, bound actions, surface deletion and checkpointed review |
| [`deep-agent`](https://github.com/skein-js/skein-js/tree/main/examples/deep-agent)                 | Research briefing assistant on Deep Agents _(experimental)_: memory, subagents, approval |
| [`invoke-endpoint`](https://github.com/skein-js/skein-js/tree/main/examples/invoke-endpoint)       | Non-chat graphs as plain HTTP endpoints                                                  |
| [`embed-graph`](https://github.com/skein-js/skein-js/tree/main/examples/embed-graph)               | A graph you already have, served with no `langgraph.json`                                |
| [`migrated-langgraph`](https://github.com/skein-js/skein-js/tree/main/examples/migrated-langgraph) | The drop-in proof — a stock LangGraph project under `skein dev`                          |
| [`react-usestream`](https://github.com/skein-js/skein-js/tree/main/examples/react-usestream)       | A minimal `useStream` frontend against any skein server                                  |
| [Daybook — Electron](https://github.com/skein-js/skein-js/tree/main/examples/desktop-electron)     | Meeting context tools, streaming, recap review, and Markdown revisions                   |
| [Reading Room — Tauri](https://github.com/skein-js/skein-js/tree/main/examples/desktop-tauri)      | Local documents, library tools, source excerpts, and reviewed reading briefs             |
| [Dayplan — CLI](https://github.com/skein-js/skein-js/tree/main/examples/local-cli)                 | Local task files, previous plans, and approval before saving                             |
