# Why skein-js

You can build an agent in an afternoon. Putting it in front of real users is the part nobody warns
you about. This page is the honest version of how that goes, what your options are, and where
skein-js fits — including where it doesn't.

## How everyone gets here

<ol class="skein-steps">
<li>

**You write an agent, and it works.** Twenty lines of LangGraph. It answers questions, calls a tool,
returns a result. You demo it and people are impressed.

</li>
<li>

**Someone asks to use it.** So you wrap it in an HTTP handler. Fine — an hour's work.

</li>
<li>

**"Can it remember what I said?"** Now you need conversations that persist, keyed to a user, restored
on the next request. That's a schema, a migration, and a serialization format for graph state.

</li>
<li>

**"Why does it take nine seconds to say anything?"** It doesn't — it's just not streaming. So you add
server-sent events. Then a client drops mid-answer and you add reconnect-and-replay.

</li>
<li>

**"Legal needs to approve before it sends."** Your agent has to _stop_, wait for a human who might
answer tomorrow, and resume from exactly where it paused — across a deploy. That's checkpointing.

</li>
<li>

**"Run it every morning."** A scheduler. Which must not fire twice when you scale to two servers.

</li>
<li>

**"Tell our CRM when it's done."** A webhook. Which must not be lost when the receiver is redeploying,
so now you own a retry queue and an outbox.

</li>
<li>

**Something breaks at 2am** and you have no idea which conversation, which step, or what the agent
actually saw.

</li>
</ol>

None of that was your product. All of it is load-bearing. It's a few thousand lines you'd own
forever, and every item has a failure mode you find in production rather than in review.

**skein-js is that entire list, already built, on your own infrastructure.**

## Your four options

<div class="skein-cards">
<div class="skein-card">
<span class="ico">🔨</span>

### Build it yourself

Total control, no dependency. Also the few thousand lines above, plus the ongoing cost of keeping up
with a protocol other people's clients expect.

</div>
<div class="skein-card">
<span class="ico">💳</span>

### LangGraph Platform

The managed option, and genuinely good. Paid per seat plus metered compute; production self-hosting
is an Enterprise add-on requiring a commercial licence key.

</div>
<div class="skein-card">
<span class="ico">🐍</span>

### aegra

The leading _open_ self-hosted alternative, and the project that inspired this one. Excellent — and
Python only, so a TypeScript team runs a second language in production.

</div>
<div class="skein-card">
<span class="ico">🧵</span>

### skein-js

Open source, self-hosted, TypeScript. Your database, your servers, no licence key, no per-run bill —
and a one-word path back out if you change your mind.

</div>
</div>

## How they compare

|                               | LangGraph Platform         | aegra       | **skein-js**                                     |
| ----------------------------- | -------------------------- | ----------- | ------------------------------------------------ |
| Language                      | Python + JS                | Python only | **TypeScript**                                   |
| Licence                       | Elastic License 2.0        | Apache-2.0  | **Apache-2.0**                                   |
| Self-host in production       | Enterprise add-on + key    | ✅          | ✅ **no key**                                    |
| Cost                          | Per-seat + metered compute | Free        | **Free**                                         |
| Your own database             | Managed, or Enterprise     | ✅          | ✅                                               |
| Studio-style UI               | Hosted, needs an account   | —           | ✅ **yours, at `/console`**                      |
| Drop-in for the LangGraph CLI | —                          | Partial     | ✅ **one word**                                  |
| HTTP framework                | Theirs                     | FastAPI     | **Express · Fastify · NestJS · Next.js · Fetch** |

## Your stack is already TypeScript

Look at what you've already got. The frontend is TypeScript. The API is TypeScript. The types are
shared across them, the CI is one pipeline, the team reviews each other's code. Then the agent shows
up, and it's the one component anyone suggests you write in a different language.

That's a real cost, and it's usually undercounted. The expensive part isn't the extra runtime — it's
that **nothing crosses the boundary**:

- **Types stop dead.** The agent's input and output are the shapes your app cares most about, and
  they become a Zod schema on one side and a Pydantic model on the other, kept in step by hand. You
  find out they've drifted in production, not at compile time.
- **You can't reuse what you've already written.** The validation, the domain rules, the permission
  checks, the money and date formatting — your API has all of it, and the agent can reach none of it.
  So you duplicate it, and the two copies drift; or you put it behind HTTP, and the agent makes a
  network call to your own API to ask what a customer's plan is.
- **The agent's output is a UI contract, and it's the one that hurts most.** A node returns a
  structured result — a booking, a diff, a set of options, a chart spec — and a component in your app
  renders it. In one language that's a single exported type shared by the node that produces it and
  the component that draws it, with the compiler catching a mismatch before you ship. Across two it's
  a shape declared in Pydantic, re-declared in TypeScript, and rendered on trust. Same story for a
  tool's schema: one Zod object can validate the model's arguments _and_ generate the form your UI
  shows.
- **Two of everything around the code.** Two dependency trees to patch, two test runners, two CI
  pipelines, two Dockerfiles, two streams of security advisories, two ways to configure a logger.
- **Review narrows.** A team fluent in TypeScript reviewing Python is working outside its
  day-to-day, so in practice one or two people end up owning the agent. That shows up as slow reviews
  long before it shows up as an incident.
- **A smaller pool of people who can fix it.** At 2am the question isn't which language is nicer,
  it's who on the team can read the stack trace.

**The honest counterpoint:** Python's ML ecosystem is deeper, and that's not close. If your agent
does real numerical work, or reaches a model or library that only exists in Python, pay the cost —
it's worth it, and [aegra](https://github.com/aegra/aegra) is very good.

But that isn't the common case. The common case is an LLM behind an HTTP API, calling tools that are
your own services. Every major model provider ships a first-class TypeScript SDK, LangGraph has a
JavaScript implementation, and the whole thing can be one language, one deploy, one set of types.

Agent tooling in JavaScript has lagged the Python side — not because the ecosystem is smaller, but
because the infrastructure kept getting built there first. skein-js is one piece of closing that gap:
the production server was the missing part, so we built it, in the open, for the language most
product teams already ship.

## The licensing part, plainly

You _can_ self-host LangGraph Platform (now LangSmith Deployment). But production self-hosting is an
**Enterprise add-on that requires a commercial licence key** — the platform's server runtime is
source-available under the
[Elastic License 2.0](https://www.elastic.co/licensing/elastic-license), which is not an open-source
licence. The managed **Plus** plan is **$39 / seat / month**, includes one small serverless
deployment, and meters additional compute and storage on top. Fully self-hosted and hybrid deployment
are Enterprise-only, with custom pricing.

_As of August 2026 — see [langchain.com/pricing](https://www.langchain.com/pricing) and the
[self-hosting docs](https://docs.langchain.com/langsmith/self-hosted). Always verify current terms._

If you're a solo developer, a small team, or just trying an idea, that model is a poor fit. You
shouldn't need a commercial licence or a per-run bill to ship a side project.

## The same stack in dev and production

With a managed platform, local development is an _approximation_ of production. You develop against a
dev server, ship to someone else's service, and the gap between the two is where the surprises live —
because the thing you deploy to is a thing you cannot run yourself.

Self-hosted and open source removes that gap entirely:

```bash
skein dev --store postgres --queue redis   # the real drivers, on your machine
skein up                                   # app + Postgres + Redis, via Compose
skein build                                # the image you deploy — `skein start` runs inside it
```

The same checkpointer, the same migrations, the same BullMQ queue semantics, the same code path. When
something misbehaves in production you can reproduce it locally, because there is no privileged
environment you're locked out of.

And when reproducing isn't enough, you can read the server — all of it, Apache-2.0 — set a breakpoint
in it, and patch it. That's not a small thing at 2am.

## We want leaving to be easy

This is the part that's easy to leave unsaid.

skein-js is a **drop-in for the LangGraph CLI on an unchanged `langgraph.json`**. That's usually
pitched as "migration is one word" — and it is. But the same fact runs in both directions: if your
team grows, you want SLAs and managed operations, and LangGraph Platform starts making sense, then
**switching back is also one word**.

That's deliberate. Low lock-in in both directions means you can start free, ship something real, and
adopt a managed platform if and when it's actually worth paying for — instead of choosing your
production architecture on day one, under uncertainty, and living with it.

It's also the standard we hold ourselves to: we'd rather you stay because skein-js keeps being the
right fit than because leaving got expensive.

## Won't it drift out of compatibility?

The reasonable worry about any community project tracking a commercial one: it falls behind, breaks
subtly, and strands you.

That isn't the shape of this, because **compatibility here isn't maintained by hand**. The wire
format is `@langchain/langgraph-sdk`'s own types — the SDK's types _are_ the contract, so `useStream`
works by construction rather than because someone keeps a copy in sync. Your agent runs on
LangGraph's runtime, saves through its checkpointers, and your `langgraph.json` is read by its
parser.

That reuse is possible because on JavaScript the pieces are **MIT-licensed**, including the Agent
Protocol server internals
([`@langchain/langgraph-api`](https://github.com/langchain-ai/langgraphjs/tree/main/libs/langgraph-api)).
skein-js wraps them; it doesn't clone them, so there's no second implementation to fall behind.

skein-js builds only what open source genuinely lacks: durable production storage and queueing, the
framework adapters, the console, and the drop-in CLI. The package-by-package ledger of what's reused
versus rebuilt is in
[reuse.md](https://github.com/skein-js/skein-js/blob/main/docs/reuse.md).

## Why we bet on LangGraph

skein-js is built for LangGraph.js, and that isn't incidental — it's the choice the whole project
rests on. Here's the reasoning, because if you're adopting skein you're adopting that bet too.

The short version: it isn't a new or niche framework. It's LangChain's, it's MIT, and it pulls
[millions of npm downloads a week](https://www.npmjs.com/package/@langchain/langgraph) — so the part
of your stack doing the actual agent work is the well-trodden part.

**Control flow is explicit.** You break the agent into discrete steps — nodes — connected by a state
they each read and write, and routing is a decision you can point at. As LangChain's own
[Thinking in LangGraph](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)
puts it, "you can always understand what your agent will do next by looking at the current node."
That sounds academic until you need to pause halfway through, resume after a deploy, or ask what the
agent saw three steps ago — at which point an explicit graph is the difference between a feature and
a rewrite.

**Its persistence primitives are exactly what a server needs.** Checkpointers aren't a nice-to-have
we work around; they're the substrate. LangGraph writes a checkpoint at node boundaries, and
human-in-the-loop, time travel, resumable runs and crash recovery all fall out of that one fact — a
run that stops resumes from the node it stopped in, days later, on a different machine. A framework
without it would make most of this page impossible to build.

**The client ecosystem already exists.** `useStream`, the SDK, Agent Chat UI, Studio — all of it
speaks one protocol, and the wire types are the SDK's own. Betting on LangGraph means your users'
frontends work by construction rather than through a compatibility layer someone maintains.

**And the graph is portable.** Nothing in your graph code is skein-specific — no imports, no
decorators, no lifecycle hooks. It's the same file that runs under `langgraph dev` or on LangGraph
Platform. That's what makes [leaving easy](#we-want-leaving-to-be-easy) in both directions.

### So, am I locked in?

To LangGraph, **today, mostly yes** — and it's worth saying plainly rather than overselling a seam.
Your agent runs on LangGraph's runtime, state persists through its checkpointers, `langgraph.json`
uses its parser. It isn't merely the supported path; it's the complete one.

What _is_ decoupled is narrower:

- **The protocol engine carries no graph runtime.** `@skein-js/agent-protocol` installs without
  LangGraph or LangChain, and a test pins that. The LangGraph binding is a separate package using
  only the engine's public entry point.
- **The runner seam is real, but partial.** The engine drives an `AgentGraph` — `stream` and
  `getState` required, the rest optional — so another runtime _can_ serve the protocol. It would
  bring its own persistence, and lose what's LangChain-specific by construction: `events` stream mode
  is a LangChain demux, and time travel needs `updateState` + `getStateHistory` you'd write yourself.
  The limits are listed honestly in [building a runner](./building-a-runner.md#known-limits).
- **Your clients were never tied to skein.** They speak the Agent Protocol, so on that side the thing
  you'd migrate is a URL.

Practically: if you're not writing LangGraph.js graphs, skein-js probably isn't for you yet.

What we deliberately **don't** do is argue LangGraph beats every alternative — that's LangChain's
case to make, and their [docs](https://docs.langchain.com/oss/javascript/langgraph/overview) make it.
The above is why _we_ built on it.

## Who this is for

<div class="skein-cards">
<div class="skein-card">

### A good fit

TypeScript teams who want their agents and their data on their own infrastructure · anyone whose
compliance story rules out a managed control plane · developers who want to ship a side project
without a per-run bill · teams already on the LangGraph CLI who need a production story.

</div>
<div class="skein-card">

### Probably not for you

Python-first teams — use [aegra](https://github.com/aegra/aegra), it's good · teams who want managed
operations, SLAs and a vendor to call — that's what LangGraph Platform is for · anyone who wants
`skein deploy` to a hosted platform, which is a deliberate non-goal.

</div>
</div>

## What we deliberately don't do

Being honest about the edges is part of the pitch:

- **No hosted platform.** Self-hosted by design; there's no managed target to deploy to.
- **No WebSocket transport.** Server-sent events cover the client experience and the React SDK
  doesn't care.
- **No sub-minute schedules**, and no backfilling schedules missed during an outage.
- **No exactly-once webhook delivery.** Delivery is durable — the callback commits in the same
  transaction as the run's terminal status, and is retried until it lands. What it is not is
  exactly-once, which is why every attempt carries a stable dedup key.
- **We don't restate LangGraph's docs.** We document our _conformance_ and the delta.

The full list of what's shipped, in preview, and planned is on the [features page](./features.md) and
the [roadmap](./roadmap.md).

## Convinced, or curious?

```bash
npm create skein-js@latest my-agent
cd my-agent && npm run dev
```

No API key, no database, no Docker. [Your first agent](./your-first-agent.md) takes it from there —
or if you already have a LangGraph project, [change one word](./langgraph-cli-compat.md).
