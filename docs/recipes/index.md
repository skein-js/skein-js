# Recipes

Task-oriented pages: a problem and the smallest code that solves it. Runnable examples named here are
in the repo and exercised by CI; provider integration snippets are checked against the linked official
SDK documentation. For a terse API reference see [using-skein.md](../using-skein.md).

## Read working code first

[`triage-agent`](https://github.com/skein-js/skein-js/tree/main/examples/triage-agent) covers crons,
background runs, idempotency, human-in-the-loop, long-term memory and time travel in **one graph** — and
runs with **no API key and no network** (bundled fixtures, deterministic fallback classifier).

```bash
pnpm --filter @skein-js/example-triage-agent dev    # console at http://127.0.0.1:2024/console/
pnpm --filter @skein-js/example-triage-agent seed   # register the schedule + sweep once
```

## The recipes

| Page                                                       | Covers                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Serving](./serving.md)                                    | Pick an adapter, serve a graph as a plain endpoint, CORS for a browser      |
| [Running agents](./running-agents.md)                      | Background runs, crons, idempotency, human-in-the-loop, run timeouts        |
| [Coupled WhatsApp workflow](./coupled-channel.md)          | A workflow with the same provider as source and destination                 |
| [Cross-provider workflow](./decoupled-channel-delivery.md) | Email source → LangGraph workflow → allowlisted WhatsApp/email destinations |
| [Memory](./memory.md)                                      | `getStore()`, semantic search, and the dedup trap                           |
| [Authenticating requests](./authentication.md)             | Better Auth, Clerk, Supabase, Firebase, OIDC/JWT, and authorization policy  |
| [Production](./production.md)                              | Auth, run-completion webhooks, durable storage and deploying                |

## Which example shows what

| Example                                                                                            | Shows                                                                           |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`triage-agent`](https://github.com/skein-js/skein-js/tree/main/examples/triage-agent)             | Crons, background runs, idempotency, HITL, memory, time travel                  |
| [`decoupled-delivery`](https://github.com/skein-js/skein-js/tree/main/examples/decoupled-delivery) | Routed channels: email source → approval workflow → WhatsApp/email destinations |
| [`chat-app`](https://github.com/skein-js/skein-js/tree/main/examples/chat-app)                     | Full-stack chat: streaming, thinking, tool cards, HITL, memory                  |
| [`invoke-endpoint`](https://github.com/skein-js/skein-js/tree/main/examples/invoke-endpoint)       | Non-chat graphs as plain HTTP endpoints                                         |
| [`embed-graph`](https://github.com/skein-js/skein-js/tree/main/examples/embed-graph)               | A graph you already have, served with no `langgraph.json`                       |
| [`migrated-langgraph`](https://github.com/skein-js/skein-js/tree/main/examples/migrated-langgraph) | The drop-in proof — a stock LangGraph project under `skein dev`                 |
| [`react-usestream`](https://github.com/skein-js/skein-js/tree/main/examples/react-usestream)       | A minimal `useStream` frontend against any skein server                         |
