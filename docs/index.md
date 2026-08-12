---
layout: home
# `layout: home` gives the page no H1, so without this the <title> is the bare site name — the most
# valuable string on the most-linked page, wasted. Containing "skein-js" also trips the `selfTitled`
# branch in transformPageData, which drops the "| skein-js" suffix rather than repeating it.
title: skein-js — The open-source LangGraph Platform alternative, for TypeScript
description: The open-source LangGraph Platform alternative for TypeScript. Self-host LangGraph.js agents with threads, streaming, human-in-the-loop, memory and crons.

hero:
  name: skein-js
  text: The open-source LangGraph Platform alternative, for TypeScript
  tagline: Self-host your LangGraph.js agents on your own infrastructure — your servers, your database, your data. Apache-2.0, no licence key, no per-run bill.
  # Each action goes somewhere distinct. A primary CTA that scrolls 200px down the page it is already
  # on is not a call to action — the 60-second command is in the first section regardless.
  actions:
    - theme: brand
      text: Get started
      link: /your-first-agent
    - theme: alt
      text: Why skein-js?
      link: /why
    - theme: alt
      text: See it running
      link: "#see-it"

# Written from the seat of the person *using* the agent, not the one running it: six things that
# separate an agent people trust from a demo. The model and the tools are the developer's (LangGraph's,
# unchanged) — these six are what they would otherwise build a backend for, so each card links to the
# page that block lives on.
features:
  - icon: 🧠
    title: Memory & persistence
    details: Short-term state checkpointed per conversation, and long-term memory that outlives every one of them — three different lifetimes, and users notice when you only have the first.
    link: /state-and-context
    linkText: State, context & persistence
  - icon: 💬
    title: Threads & session state
    details: "Multi-turn conversations that survive requests, restarts and deploys — addressable by an id you already have: a ticket, a phone number, a customer."
    link: /threads
    linkText: Threads & time travel
  - icon: ⚡
    title: Streaming
    details: Tokens, tool calls and reasoning as they happen — surviving a dropped connection, a refresh, and a second device joining halfway through.
    link: /streaming
    linkText: Streaming & SSE
  - icon: 🎛️
    title: Human-in-the-loop
    details: Pause for approval on anything consequential, take a correction mid-run, rewind a turn and try it again — hours later, from another machine.
    link: /human-in-the-loop
    linkText: Interrupts & steering
  - icon: 🔄
    title: Scheduling & background work
    details: Work that outlives the request — schedules that don't double-fire across servers, background jobs, and a callback when they finish.
    link: /background-jobs
    linkText: Background jobs & crons
  - icon: 🛡️
    title: Durable execution
    details: A run whose process died is recovered, not lost. Two messages on one conversation serialize. One server or ten, the work still completes.
    link: /deploy
    linkText: Running it in production
---

## Your agent works on your laptop. Now what? {#start}

You could wrap it in Express yourself — it's an afternoon, and then it's five categories of plumbing
you maintain forever. None of it is what your users came for.

**skein-js is that backend, and it starts in one command:**

```bash
npm create skein-js@latest my-agent
cd my-agent && npm run dev
```

You now have an agent server on `http://localhost:2024` and a control room at `/console`. **No API
key, no database, no Docker** — the agent it writes for you runs offline, so the first thing you see
is your own agent working rather than a credentials error.

Talk to it with the client you'd already be using. **If it speaks the Agent Protocol, it works** —
you're only changing a URL:

:::tabs

== Any framework

```ts
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });
const thread = await client.threads.create();

for await (const chunk of client.runs.stream(thread.thread_id, "agent", {
  input: { messages: [{ role: "human", content: "hello" }] },
  streamMode: "messages",
})) {
  console.log(chunk);
}
```

== React

```tsx
import { useStream } from "@langchain/langgraph-sdk/react";

const thread = useStream({ apiUrl: "http://localhost:2024", assistantId: "agent" });

thread.submit({ messages: [{ type: "human", content: input }] });
// thread.messages updates live as tokens arrive; thread.interrupt holds a pending approval
```

== Vue

```ts
import { useStream } from "@langchain/vue";

const thread = useStream({ apiUrl: "http://localhost:2024", assistantId: "agent" });

thread.submit({ messages: [{ type: "human", content: input }] });
```

== Svelte

```ts
import { getStream, provideStream } from "@langchain/svelte";

provideStream({ apiUrl: "http://localhost:2024", assistantId: "agent" });
const thread = getStream();

thread.submit({ messages: [{ type: "human", content: input }] });
```

== Angular

```ts
import { injectStream } from "@langchain/angular";

const thread = injectStream({ apiUrl: "http://localhost:2024", assistantId: "agent" });

thread.submit({ messages: [{ type: "human", content: input }] });
```

:::

All four bindings are thin wrappers over the **same** `@langchain/langgraph-sdk`, so they issue
identical requests and read identical frames. Agent Chat UI and LangGraph Studio work the same way,
for the same reason. Details and the honest caveats: [react-sdk.md](./react-sdk.md).

[**Your first agent**](./your-first-agent.md) takes it from here to deployed — and teaches you the
LangGraph you need on the way, if you're new to it.

## How it fits together

Three moving parts. Your clients and your agent are the ones you already have.

<svg class="skein-arch" viewBox="0 0 680 352" role="img" aria-label="Your clients speak the Agent Protocol to skein-js, which runs your LangGraph agent and stores state in your own Postgres and Redis.">
  <!-- clients -->
  <rect class="box" x="70" y="6" width="360" height="60" rx="10" />
  <text class="t" x="250" y="30" text-anchor="middle">Your clients</text>
  <text class="t-sub" x="250" y="50" text-anchor="middle">LangGraph SDK · useStream · Agent Chat UI</text>
  <!-- clients → skein -->
  <path class="wire" d="M250 66 V110" />
  <path class="wire" d="M244 104 L250 110 L256 104" />
  <circle class="pulse pulse-a" cx="250" cy="68" r="3.5" style="--travel: 40px" />
  <text class="t-edge" x="264" y="92">Agent Protocol · HTTP + SSE</text>
  <!-- skein -->
  <rect class="box-accent" x="70" y="110" width="360" height="96" rx="10" />
  <text class="t" x="250" y="140" text-anchor="middle">skein-js</text>
  <text class="t-sub" x="250" y="163" text-anchor="middle">runs · threads · streaming · approvals</text>
  <text class="t-sub" x="250" y="182" text-anchor="middle">memory · schedules · webhooks · console</text>
  <!-- skein → storage -->
  <path class="wire" d="M430 158 H500" />
  <rect class="box" x="500" y="132" width="164" height="52" rx="10" />
  <text class="t-sub" x="582" y="153" text-anchor="middle">Your Postgres</text>
  <text class="t-sub" x="582" y="171" text-anchor="middle">Your Redis</text>
  <!-- skein → agent -->
  <path class="wire" d="M250 206 V250" />
  <path class="wire" d="M244 244 L250 250 L256 244" />
  <circle class="pulse pulse-b" cx="250" cy="208" r="3.5" style="--travel: 40px" />
  <!-- agent -->
  <rect class="box" x="70" y="250" width="360" height="60" rx="10" />
  <text class="t" x="250" y="274" text-anchor="middle">Your agent</text>
  <text class="t-sub" x="250" y="294" text-anchor="middle">a LangGraph.js graph, unchanged</text>
</svg>

Your clients don't know skein-js exists — they speak a standard. Your agent doesn't either. skein-js
is the middle box, and it's the only part you didn't have to write.

## You're not learning a new framework

The agent itself is **plain LangGraph.js** — LangChain's own framework, MIT-licensed and pulling
[millions of downloads a week](https://www.npmjs.com/package/@langchain/langgraph) on npm. skein-js
introduces no framework of its own, and there is nothing skein-specific in your graph code. No
imports of ours, no decorators, no lifecycle hooks:

<!-- prettier-ignore -->
```ts
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";

export const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", callModel)      // your step
  .addEdge("__start__", "agent")    // what runs next
  .compile();
```

That's the whole contract. The same file runs under `langgraph dev`, on LangGraph Platform, or on
skein — which is why migrating is one word in either direction, and why
[`migrated-langgraph`](https://github.com/skein-js/skein-js/tree/main/examples/migrated-langgraph)
is a stock LangGraph project with nothing changed but a script.

New to it? LangChain's
[Thinking in LangGraph](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)
is the shortest path to the mental model — nodes, shared state, and explicit routing.

So the thing you're betting on for your agent logic is LangChain's, not ours. What skein-js adds is
everything around it. [Why we bet on LangGraph →](./why.md#why-we-bet-on-langgraph)

> **Not using LangGraph?** The protocol engine carries no graph runtime, so another agent runtime can
> serve the same API by implementing two methods — bringing its own persistence and giving up the
> LangChain-specific pieces. The honest limits are in
> [building a runner](./building-a-runner.md#known-limits).

## Your stack is already TypeScript

<p class="skein-quote">Your frontend is TypeScript. Your API is TypeScript. Why is your agent in <em>Python</em>?</p>

The cost of a Python sidecar isn't the extra runtime. It's that **nothing crosses the boundary** —
your types stop dead, the domain logic your API already has is unreachable, and the agent's
structured output, the thing your UI actually renders, becomes a shape declared twice and trusted
once.

Keeping it in one language collapses the stack. The people who already ship your product can build
the agent, review each other's work on it, and fix it when it matters — one toolchain, one CI, one
set of types, and no small group who are the only ones able to touch it.

[The longer argument, if you want to nerd out →](./why.md#your-stack-is-already-typescript)

## See it running {#see-it}

This ships in the box. It's the thing you'd otherwise reach for LangGraph Studio to get, except
**your own server hosts it** — no account, no sign-in, no internet connection, no tunnel back to your
laptop.

<div class="light-only">

![The skein console: two conversations waiting on a human, live counts, and recent activity](/images/console/overview-light.png)

</div>
<div class="dark-only">

![The skein console: two conversations waiting on a human, live counts, and recent activity](/images/console/overview-dark.png)

</div>

**"Waiting for you"** is the one that changes how you build. Any conversation your agent paused for a
human shows up there — approve it, reject it, or send back whatever answer you like, and the agent
carries on from exactly where it stopped. Hours later. After a redeploy. From a different machine.

<div class="light-only">

![The console filtered to conversations paused for a human decision](/images/console/interrupts-light.png)

</div>
<div class="dark-only">

![The console filtered to conversations paused for a human decision](/images/console/interrupts-dark.png)

</div>

There's more behind it: a playground that draws your agent's shape and streams a run into it, live
run tails you can cancel or roll back, a memory browser with semantic search, and schedule
management. It's **off by default in production** — you opt in, because it can read and delete
everything.

[Take the tour →](./console.md)

## Bring what you already have

Four ways in. Pick yours — they all end at the same server.

:::tabs

== Starting fresh

One command, and you have a working agent to edit:

```bash
npm create skein-js@latest my-agent
cd my-agent && npm run dev
```

Pick a model provider with `--provider anthropic|openai|google`, or take the keyless default and add
one later. [Scaffolding reference →](./scaffolding.md)

== On the LangGraph CLI

Change one word. Your `langgraph.json`, your agent and your clients stay exactly as they are:

```diff
- "dev": "langgraph dev",
+ "dev": "skein dev",
```

That's the whole migration. Every honoured config field is listed in
[LangGraph CLI compatibility →](./langgraph-cli-compat.md)

== Agent in an app I run

Bring it in code — no config file, no CLI. `{ deps }` is the seam every adapter accepts, so the same
two lines work on Fastify, NestJS, Next.js and Fetch:

```ts
import { createExpressServer } from "@skein-js/express";
import { embedInMemoryGraphs } from "@skein-js/server-kit";
import { graph } from "./my-graph.js";

const server = await createExpressServer({ deps: embedInMemoryGraphs({ agent: graph }) });
await server.listen(2024);
```

[More on embedding →](./embedding.md)

== Not a chat product

For a classifier, an extractor, or a workflow another service calls, skip threads and runs entirely.
Each agent gets one endpoint: your JSON in, its answer out.

```bash
curl -sX POST localhost:2024/invoke/triage \
  -H 'content-type: application/json' \
  -d '{"text":"Refund charge failed — urgent!"}'
```

[Serving a single graph →](./serving-a-single-graph.md)

:::

## Why skein-js? {#why-skein-js}

<div class="skein-cards">
<a class="skein-card" href="./why#how-everyone-gets-here">
<span class="ico">🔨</span>

### Cheaper than building it

Every one of those six blocks is load-bearing, none of them are your product, and each has a failure
mode you'd meet in production rather than in review.

<span class="skein-card-link">How everyone gets here</span>

</a>
<a class="skein-card" href="./why#the-licensing-part-plainly">
<span class="ico">🔑</span>

### Self-hosting without a sales call

LangGraph Platform is paid, and production self-hosting needs a commercial Enterprise licence key.
skein-js is Apache-2.0. Your database, your servers, no key.

<span class="skein-card-link">The licensing part, plainly</span>

</a>
<a class="skein-card" href="./why#the-same-stack-in-dev-and-production">
<span class="ico">💻</span>

### The same stack, dev and prod

`skein dev --store postgres --queue redis` is the real thing, not an approximation — same
checkpointer, same queue, same image you deploy. Reproduce a production bug locally, and read the
source when that isn't enough.

<span class="skein-card-link">Same stack in dev and production</span>

</a>
<a class="skein-card" href="./why#we-want-leaving-to-be-easy">
<span class="ico">↔️</span>

### Leaving is one word

It's a drop-in on an unchanged config — which runs _both_ ways. Start free here, move to a managed
platform later if it's worth paying for. That's deliberate.

<span class="skein-card-link">Why we want leaving to be easy</span>

</a>
<a class="skein-card" href="./why#why-we-bet-on-langgraph">
<span class="ico">🧩</span>

### Built on LangGraph, deliberately

Agents are state machines, and LangGraph is honest about it — its checkpointers are what make
approvals, time travel and crash recovery possible at all. On JavaScript it's genuinely open source,
which is why skein-js can be thin rather than a reimplementation.

<span class="skein-card-link">Why we bet on LangGraph</span>

</a>
</div>

## Steal our examples

Every one of these runs, and CI proves it.

| Example                                                                                            | What it shows                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [`triage-agent`](https://github.com/skein-js/skein-js/tree/main/examples/triage-agent)             | **Start here** — schedules, background work, approvals, memory and rewind in one agent. **No API key, no network needed** |
| [`chat-app`](https://github.com/skein-js/skein-js/tree/main/examples/chat-app)                     | **Flagship** — a research assistant with thinking, web search and memory, behind a Next.js + shadcn/ui UI                 |
| [`migrated-langgraph`](https://github.com/skein-js/skein-js/tree/main/examples/migrated-langgraph) | The drop-in proof — a stock LangGraph project running under `skein dev`                                                   |

Eleven more in [`examples/`](https://github.com/skein-js/skein-js/tree/main/examples), including one
per adapter — standalone, and mounted inside an app that already has its own routes.

## Where to go next

New here? [**Your first agent**](./your-first-agent.md) goes from an empty directory to deployed,
then [**what you need to know**](./what-you-need-to-know.md) maps everything it skipped. Never
written a graph? [**LangGraph essentials**](./langgraph-essentials.md) is the short version.
Wondering if skein does something specific? The [**features page**](./features.md) answers it in one
line. Building _with_ an AI agent?
[`llms.txt`](https://github.com/skein-js/skein-js/blob/main/llms.txt) hands it the whole set.

---

**If this saved you a week, [give it a star](https://github.com/skein-js/skein-js)** — it's how other
TypeScript teams find it. Hit something that doesn't work?
[Tell us](https://github.com/skein-js/skein-js/issues); compatibility reports are the most useful
feedback we get.
