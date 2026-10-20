---
layout: home
title: skein-js — Self-host LangGraph.js agents in TypeScript
description: Run LangGraph.js agents on your own infrastructure. Skein provides APIs, persistence, streaming, background jobs, and a console, with SQLite embedding for local apps.

hero:
  name: skein-js
  text: Run LangGraph.js agents on your own infrastructure.
  tagline: An open-source TypeScript runtime that handles the backend around your graphs, so you can focus on your application.
  actions:
    - theme: brand
      text: Get started
      link: /your-first-agent
    - theme: alt
      text: Use an existing graph
      link: /getting-started

features:
  - icon: 🧠
    title: Conversation state & memory
    details: Keep conversation history and recall information across threads. Choose Postgres for shared servers or SQLite for local persistence.
    link: /state-and-context
    linkText: State and persistence
  - icon: ⚡
    title: Streaming & standard clients
    details: Deliver tokens, tool activity, and graph updates through the LangGraph SDK and its frontend bindings, including React's useStream.
    link: /streaming
    linkText: Streaming and SSE
  - icon: 🎛️
    title: Approvals & checkpoint history
    details: Pause a graph for human input, resume after a decision, or explore a different outcome from a saved checkpoint.
    link: /human-in-the-loop
    linkText: Human-in-the-loop
  - icon: 🔄
    title: Background jobs & schedules
    details: Let work continue after a request ends, run agents on a schedule, and receive a callback when a run finishes.
    link: /background-jobs
    linkText: Background work
  - icon: 🔌
    title: Channels & durable callbacks
    details: Connect authenticated events to a graph and deliver its outcome to an allowed destination. Inspect and replay webhook deliveries.
    link: /channels
    linkText: Workflows and channels
  - icon: 🎛️
    title: Console & observability
    details: Test graphs, review approvals, and inspect runs in your own console. Connect LangSmith, PostHog, or OpenTelemetry for tracing and analytics.
    link: /console
    linkText: Explore the console
---

## Why skein-js? {#why-skein-js}

skein-js is an open-source TypeScript runtime for hosting LangGraph.js agents. LangGraph defines and
executes your graphs; Skein provides the API, persistence, streaming, background work, and console
around them.

A working graph still needs a backend before people can use it. Skein supplies that infrastructure
so you can ship an assistant, research tool, or approval workflow while keeping your graph code,
models, and tools. It is an Apache-2.0 alternative to LangGraph Platform (now LangSmith Deployment)
that you run on your own infrastructure.

## Quick start {#start}

Use **Node 24** (recommended):

```bash
npm create skein-js@latest my-agent
cd my-agent
npm run dev
```

Accept the scaffolder's defaults to install dependencies and try an echo graph that needs no API key,
database service, or Docker. Open `http://localhost:2024/console` and send a message.

[Your first agent](./your-first-agent.md) takes you through adding a model and tools, then deploying.
Skein is **pre-alpha**; see the [roadmap](./roadmap.md) for support and known gaps.

### Already using LangGraph?

Install the CLI in your project with `npm install -D skein-js`, then replace `langgraph dev` with
`skein dev`. Keep your `langgraph.json`, graph exports, and LangGraph SDK clients.
[CLI compatibility](./langgraph-cli-compat.md) documents supported commands, fields, and limitations.

## Run it your way

| Path                  | Use it for                                                               | Guide                                     |
| --------------------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| **Standalone server** | A shared service with Postgres and Redis                                 | [Server deployment](./deploy.md)          |
| **Existing backend**  | Graphs alongside your Express, Fastify, NestJS, or Next.js routes        | [Embedding](./embedding.md)               |
| **Local application** | A desktop app, CLI, or daemon with one Node process owning a SQLite file | [Local deployment](./local-deployment.md) |

Each path uses the same Agent Protocol engine. The default development server uses memory drivers;
choose durable storage when you need persistence beyond development.

## See it running {#see-it}

The console is served by your own process at `/console`. Test a graph, follow live runs, review
approvals, and browse memory and schedules. It is enabled in development and off by default in
production. [Take the tour](./console.md).

<div class="light-only">

![The skein console showing threads awaiting approval and recent activity](/images/console/overview-light.png)

</div>
<div class="dark-only">

![The skein console showing threads awaiting approval and recent activity](/images/console/overview-dark.png)

</div>

## Where to go next

Browse [features](./features.md) for capabilities, [recipes](./recipes/index.md) for practical
patterns, or [examples](https://github.com/skein-js/skein-js/tree/main/examples) for runnable
projects. Connect traces and analytics with [observability](./observability.md).

LangChain Deep Agents support is **experimental**: see the
[Deep Agents recipe](./recipes/deep-agents.md).
