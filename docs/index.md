---
layout: home
title: skein-js — Self-host LangGraph.js agents and Deep Agents
description: Run LangGraph.js agents and Deep Agents on shared servers, in existing backends, or inside desktop apps, CLIs, and daemons with SQLite.

hero:
  name: skein-js
  text: Run LangGraph.js agents and Deep Agents on your own infrastructure.
  tagline: >-
    An open-source TypeScript runtime for shared servers, existing backends, desktop apps, CLIs,
    and daemons.
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

<script setup>
import SkeinRuntimeOverview from "./.vitepress/theme/components/SkeinRuntimeOverview.vue";
</script>

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

Choose where Skein and your graphs live. Each option uses the same Agent Protocol engine; your
application chooses its models, credentials, and tools.

<div class="skein-cards">
<div class="skein-card">

### A shared server

An agent service running on Node or in a container. Use Postgres for durable state and Redis for queues and streaming across instances.

[Server deployment](./deploy.md)

</div>
<div class="skein-card">

### Your existing backend

Graphs alongside your Express, Fastify, NestJS, or Next.js routes, using the storage your application needs.

[Embed your graphs](./embedding.md) · [Framework adapters](./adapters.md)

</div>
<div class="skein-card">

### A local application

An Electron app, Tauri app with a Node backend, CLI, or daemon. One Node process owns the SQLite file containing resources, queued work, and checkpoints.

[Local deployment](./local-deployment.md)

</div>
</div>

Node is the default server runtime. Bun and Deno are **preview** options through the
[Fetch adapter](./adapters.md#fetch-bun-deno). The default development server uses memory drivers;
select durable storage when state must survive beyond development.

<SkeinRuntimeOverview />

The hosting options are alternatives. Enable the access methods your application needs; a local
runtime can use the native client directly or add an HTTP adapter for remote clients.

## Who can connect

Choose the connection that matches your caller, then follow its setup guide.

<div class="skein-cards">
<div class="skein-card">

### Web frontends

LangChain's official React, Vue, Svelte, and Angular SDKs, or the ready-made Agent Chat UI, over HTTP/SSE.

[Connect LangChain SDKs](./react-sdk.md) · [LangChain SDK docs](https://docs.langchain.com/oss/javascript/langchain/frontend/overview)

</div>
<div class="skein-card">

### Services and scripts

The LangGraph JavaScript SDK or Agent Protocol HTTP/SSE. Mount the single-graph adapter for a plain `/invoke/:graph_id` input/output endpoint.

[Agent Protocol](./agent-protocol.md) · [Serve a single graph](./serving-a-single-graph.md)

</div>
<div class="skein-card">

### Developer tools

The self-hosted console or LangGraph Studio pointed at your server.

[Console](./console.md) · [Studio credentials](./console-reference.md#development-authentication)

</div>
<div class="skein-card">

### Other agents

MCP clients call authorized assistants as tools; A2A clients discover agents and exchange messages and tasks.

[MCP and A2A](./agent-protocol.md#mcp-and-a2a)

</div>
<div class="skein-card">

### Embedded apps and workers

The native TypeScript client without HTTP, or optional BullMQ command and outcome queues.

[Native access and BullMQ](./native-access.md)

</div>
<div class="skein-card">

### Channels and provider events

Channels your application implements and configures to verify inbound events and deliver workflow outcomes.

[Workflows and channels](./channels.md)

</div>
</div>

Your application's [authentication and authorization](./recipes/authentication.md) determine who can
access each graph and its resources. For browser clients on another origin, configure
[CORS](./recipes/serving.md#cors-for-a-browser-client). Check the
[compatibility reference](./langgraph-compatibility.md) for tested clients and limitations.

## See it running {#see-it}

The console is served by your own process at `/console`. Test a graph, follow live runs, review
approvals, and browse memory and schedules. It is enabled in development and off by default in
production. [Test your graph in the console](./console.md), then save important cases as
[automated project tests](./testing-your-project.md).

<div class="light-only">

![Testing a graph in the skein console Playground](/images/console/playground-light.png)

</div>
<div class="dark-only">

![Testing a graph in the skein console Playground in dark mode](/images/console/playground-dark.png)

</div>

## Where to go next

Browse [features](./features.md) for capabilities, [recipes](./recipes/index.md) for practical
patterns, or [examples](https://github.com/skein-js/skein-js/tree/main/examples) for runnable
projects. Connect traces and analytics with [observability](./observability.md).

LangChain Deep Agents support is **experimental**: see the
[Deep Agents recipe](./recipes/deep-agents.md).
