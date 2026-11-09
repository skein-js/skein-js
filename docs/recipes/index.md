# Recipes

Choose a task, follow its recipe, and run the linked example to compare the result with your own
project. Each recipe uses existing public APIs. For a terse API reference, see
[Using skein-js](../using-skein.md).

## Read working code first

[`triage-agent`](https://github.com/skein-js/skein-js/tree/main/examples/triage-agent) covers crons,
background runs, idempotency, human-in-the-loop, long-term memory and time travel in **one graph** — and
runs with **no API key and no network** (bundled fixtures, deterministic fallback classifier).

```bash
pnpm --filter @skein-js/example-triage-agent dev    # console at http://127.0.0.1:2024/console/
pnpm --filter @skein-js/example-triage-agent seed   # register the schedule + sweep once
```

## The recipes

| Page                                                       | Covers                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [Serving](./serving.md)                                    | Pick an adapter, serve a graph as a plain endpoint, CORS for a browser       |
| [Running agents](./running-agents.md)                      | Background runs, crons, idempotency, human-in-the-loop, run timeouts         |
| [Coupled WhatsApp workflow](./coupled-channel.md)          | A workflow with the same provider as source and destination                  |
| [Cross-provider workflow](./decoupled-channel-delivery.md) | Email source → LangGraph workflow → allowlisted WhatsApp/email destinations  |
| [Memory](./memory.md)                                      | `getStore()`, semantic search, and the dedup trap                            |
| [Deep Agents](./deep-agents.md) _(experimental)_           | Files, per-user memory, streamed subagents, approval and async subagents     |
| [Human input over MCP](./mcp-human-input.md)               | Official client form/URL questions, tool review and resumable answers        |
| [Streaming UI with json-render](./json-render.md)          | Catalog-driven UI generation, progressive rendering, restoration and actions |
| [Authenticating requests](./authentication.md)             | Better Auth, Clerk, Supabase, Firebase, OIDC/JWT, and authorization policy   |
| [Production](./production.md)                              | Auth, run-completion webhooks, durable storage and deploying                 |
| [Local apps and SQLite](../local-deployment.md)            | Desktop, CLI, and daemon hosts with one owned database file                  |

## Which example shows what

| Example                                                                                            | Shows                                                                                    |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`triage-agent`](https://github.com/skein-js/skein-js/tree/main/examples/triage-agent)             | Crons, background runs, idempotency, HITL, memory, time travel                           |
| [`decoupled-delivery`](https://github.com/skein-js/skein-js/tree/main/examples/decoupled-delivery) | Routed channels: email source → approval workflow → WhatsApp/email destinations          |
| [`chat-app`](https://github.com/skein-js/skein-js/tree/main/examples/chat-app)                     | Full-stack chat: streaming, thinking, tool cards, HITL, memory                           |
| [`json-render`](https://github.com/skein-js/skein-js/tree/main/examples/json-render)               | React plan builder: streamed JSON UI, saved specs, revisions and approval                |
| [`deep-agent`](https://github.com/skein-js/skein-js/tree/main/examples/deep-agent)                 | Research briefing assistant on Deep Agents _(experimental)_: memory, subagents, approval |
| [`invoke-endpoint`](https://github.com/skein-js/skein-js/tree/main/examples/invoke-endpoint)       | Non-chat graphs as plain HTTP endpoints                                                  |
| [`embed-graph`](https://github.com/skein-js/skein-js/tree/main/examples/embed-graph)               | A graph you already have, served with no `langgraph.json`                                |
| [`migrated-langgraph`](https://github.com/skein-js/skein-js/tree/main/examples/migrated-langgraph) | The drop-in proof — a stock LangGraph project under `skein dev`                          |
| [`react-usestream`](https://github.com/skein-js/skein-js/tree/main/examples/react-usestream)       | A minimal `useStream` frontend against any skein server                                  |
| [Daybook — Electron](https://github.com/skein-js/skein-js/tree/main/examples/desktop-electron)     | Meeting context tools, streaming, recap review, and Markdown revisions                   |
| [Reading Room — Tauri](https://github.com/skein-js/skein-js/tree/main/examples/desktop-tauri)      | Local documents, library tools, source excerpts, and reviewed reading briefs             |
| [Dayplan — CLI](https://github.com/skein-js/skein-js/tree/main/examples/local-cli)                 | Local task files, previous plans, and approval before saving                             |
