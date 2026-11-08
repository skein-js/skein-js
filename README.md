# skein-js

[![npm](https://img.shields.io/npm/v/skein-js?logo=npm&color=cb3837&label=skein-js)](https://www.npmjs.com/package/skein-js)&nbsp;[![downloads](https://img.shields.io/npm/dm/skein-js?color=blue)](https://www.npmjs.com/package/skein-js)&nbsp;[![license](https://img.shields.io/npm/l/skein-js?color=green)](./LICENSE)&nbsp;[![CI](https://github.com/skein-js/skein-js/actions/workflows/ci.yml/badge.svg)](https://github.com/skein-js/skein-js/actions/workflows/ci.yml)&nbsp;[![docs](https://img.shields.io/badge/docs-skein.js.org-3b82f6)](https://skein.js.org/)

**Run LangGraph.js agents and Deep Agents on your own infrastructure.**

Run your graphs on shared servers, alongside your backend, or inside desktop apps, CLIs, and daemons.

skein-js is an open-source TypeScript runtime for hosting
[LangGraph.js](https://docs.langchain.com/oss/javascript/langgraph/overview) agents. LangGraph defines
and executes your graphs; Skein provides the API, persistence, streaming, background work, and console
around them.

## Why skein-js?

A graph that works in a script still needs a backend before people can use it. Conversations need
state, long-running work needs a queue, and people need a way to see what happened or approve the
next step. Building and maintaining that infrastructure takes time away from your application.

Skein supplies that backend. Keep your graph code, models, and tools, then run it as a service on
your infrastructure or inside an application you already ship. It is an Apache-2.0 alternative to
LangGraph Platform (now LangSmith Deployment), with no commercial license key required.

Build a customer-facing assistant, a research tool, or a workflow that waits for human approval.
Your existing LangGraph SDK clients and Agent Chat UI connect through the same Agent Protocol:
the HTTP and streaming API around your graphs.

## What you get

- **Conversation state and long-term memory.** Keep conversation history and recall information
  across threads. Use Postgres for shared servers or SQLite for local persistence.
  [State and persistence](./docs/state-and-context.md) · [Memory](./docs/memory.md)
- **Streaming with standard LangGraph clients.** Deliver tokens, tool activity, and graph updates as
  they happen. Connect with the LangGraph SDK and its frontend bindings, including React's
  `useStream`. [Streaming](./docs/streaming.md) · [Client integration](./docs/react-sdk.md)
- **Human approvals and checkpoint history.** Expose LangGraph interrupts to your users, resume
  after a decision, and explore a different outcome from a saved checkpoint.
  [Human-in-the-loop](./docs/human-in-the-loop.md) · [Time travel](./docs/threads.md#time-travel-re-run-a-turn-a-different-way)
- **Background jobs and schedules.** Let work continue after a request ends, run agents on a
  schedule, and receive a callback when a run finishes.
  [Background jobs](./docs/background-jobs.md) · [Schedules](./docs/crons.md)
- **Channels and durable callbacks.** Connect authenticated events from your systems to a graph and
  deliver its outcome to an allowed destination. Inspect and replay webhook deliveries.
  [Channels](./docs/channels.md) · [Webhooks](./docs/webhooks.md) · [Native access and BullMQ](./docs/native-access.md)
- **Console and observability.** Test graphs, inspect conversations, and manage approvals in your own
  console. Connect LangSmith, PostHog, or OpenTelemetry for tracing and analytics.
  [Console](./docs/console.md) · [Observability](./docs/observability.md)

## Quick start

> 🚧 **Status: pre-alpha, but end-to-end.** Development and self-hosted production work today, with
> Fetch, Express, Fastify, NestJS, and Next.js adapters. See the [roadmap](./docs/roadmap.md).

Use **Node 24** (recommended), then create a project:

```bash
npm create skein-js@latest my-agent
cd my-agent
npm run dev
```

Accept the scaffolder's defaults to install dependencies and start with an echo graph that needs no
API key, database service, or Docker. Open <http://localhost:2024/console>, create a thread, and send a
message. The server runs at <http://localhost:2024>.

[Your first agent](./docs/your-first-agent.md) walks through adding a model and tools, then deploying.
For workspace setup and generator options, see [scaffolding](./docs/scaffolding.md).

### Already using LangGraph?

Install the CLI in your existing project:

```bash
npm install -D skein-js
```

Then change your development script:

```diff
- "dev": "langgraph dev"
+ "dev": "skein dev"
```

Keep your `langgraph.json`, graph exports, and clients. See
[LangGraph CLI compatibility](./docs/langgraph-cli-compat.md) for supported commands, fields, and
limitations.

## Run it your way

Choose where Skein and your graphs live. Each option uses the same Agent Protocol engine; your
application chooses its models, credentials, and tools.

| Run Skein in              | Choose it for                                                                                                                                             | Start here                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **A shared server**       | An agent service running on Node or in a container. Use Postgres for durable state and Redis for queues and streaming across instances.                   | [Server deployment](./docs/deploy.md)                                               |
| **Your existing backend** | Graphs alongside your Express, Fastify, NestJS, or Next.js routes, using the storage your application needs.                                              | [Embed your graphs](./docs/embedding.md) · [Framework adapters](./docs/adapters.md) |
| **A local application**   | An Electron app, Tauri app with a Node backend, CLI, or daemon. One Node process owns the SQLite file containing resources, queued work, and checkpoints. | [Local deployment](./docs/local-deployment.md)                                      |

Node is the default server runtime. Bun and Deno are **preview** options through the
[Fetch adapter](./docs/adapters.md#fetch-bun-deno). The default development server uses memory drivers;
select durable storage when state must survive beyond development.

![Apps, agents, native callers, and channels connect to Skein and your graphs. Choose a shared server, existing backend, or local application.](./docs/public/images/runtime-overview.svg)

The hosting options are alternatives. Enable the access methods your application needs; a local
runtime can use the native client directly or add an HTTP adapter for remote clients.

## Who can connect

Choose the connection that matches your caller, then follow its setup guide.

| Your caller                      | How it connects                                                                                                                                | Start here                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web frontends**                | LangChain's official React, Vue, Svelte, and Angular SDKs, or the ready-made Agent Chat UI, over HTTP/SSE.                                     | [Connect LangChain SDKs](./docs/react-sdk.md) · [LangChain SDK docs](https://docs.langchain.com/oss/javascript/langchain/frontend/overview) |
| **Services and scripts**         | The LangGraph JavaScript SDK or Agent Protocol HTTP/SSE. Mount the single-graph adapter for a plain `/invoke/:graph_id` input/output endpoint. | [Agent Protocol](./docs/agent-protocol.md) · [Serve a single graph](./docs/serving-a-single-graph.md)                                       |
| **Developer tools**              | The self-hosted console or LangGraph Studio pointed at your server.                                                                            | [Console](./docs/console.md) · [Studio credentials](./docs/console-reference.md#development-authentication)                                 |
| **Other agents**                 | MCP clients call authorized assistants as tools; A2A clients discover agents and exchange messages and tasks.                                  | [MCP and A2A](./docs/agent-protocol.md#mcp-and-a2a)                                                                                         |
| **Embedded apps and workers**    | The native TypeScript client without HTTP, or optional BullMQ command and outcome queues.                                                      | [Native access and BullMQ](./docs/native-access.md)                                                                                         |
| **Channels and provider events** | Channels your application implements and configures to verify inbound events and deliver workflow outcomes.                                    | [Workflows and channels](./docs/channels.md)                                                                                                |

Your application's [authentication and authorization](./docs/recipes/authentication.md) determine who
can access each graph and its resources. For browser clients on another origin, configure
[CORS](./docs/recipes/serving.md#cors-for-a-browser-client). Check the
[compatibility reference](./docs/langgraph-compatibility.md) for tested clients and limitations.

## The console

The console is served by your own process at `/console`. Send a message in the playground, follow
live runs, review pending approvals, and browse saved memory and schedules.

![Testing a graph in the skein console Playground](./docs/public/images/console/playground-light.png)

It is enabled during development and **off by default in production**. The
[console guide](./docs/console.md) walks through testing your graph and diagnosing a result.
Use the [setup reference](./docs/console-reference.md) for authentication and mounting, then turn
important cases into [automated project tests](./docs/testing-your-project.md).

## Documentation

[Read the docs](https://skein.js.org/) for the complete guides and reference.

- [Getting started](./docs/getting-started.md) — adopt Skein with a new project or an existing graph.
- [Testing your project](./docs/testing-your-project.md) — graph assertions and a server smoke test.
- [Features](./docs/features.md) — find a capability and its guide.
- [Agent Protocol](./docs/agent-protocol.md) — API resources and authentication.
- [Recipes](./docs/recipes/index.md) — practical patterns for serving and running agents.
- [Agent skills](./docs/agent-skills.md) — setup guidance for AI coding assistants.

LangChain Deep Agents support is **experimental**: see the
[Deep Agents recipe](./docs/recipes/deep-agents.md).

For AI tools, [llms.txt](./llms.txt) indexes the docs and [llms-full.txt](./llms-full.txt) bundles them.

## Examples

Start with [triage-agent](./examples/triage-agent) for background work, schedules, and approvals
without an API key, or [chat-app](./examples/chat-app) for a research assistant with a Next.js UI.
For a generated component UI, try the [json-render plan builder](./examples/json-render): stream a
plan, restore it from thread state, revise it through buttons/forms, and approve it.
The [examples directory](./examples) also includes framework integrations, migration, and local apps.
For durable embedded calls and external command queues, use the
[native/BullMQ approval example](./examples/native-transports) and
[security guide](./docs/native-access-security.md).

## Contributing & feedback

[Open an issue](https://github.com/skein-js/skein-js/issues) for bugs and compatibility reports, or
see [CONTRIBUTING.md](./CONTRIBUTING.md) to contribute. Changes and releases are in the
[changelog](./CHANGELOG.md).

## Sponsorship

Sponsored by [Garatropic Studios](https://garatropic.com), supporting engineering and ongoing
maintenance. To support development, [get in touch](https://github.com/skein-js/skein-js/issues).

## License

[Apache-2.0](./LICENSE)
