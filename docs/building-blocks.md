# Building blocks

Use this map to choose the skein-js capabilities your project needs. Start with a working graph,
then add conversation state, human approval, background work, or durable deployment as required.
Each section explains the user decision and links to a practical guide.

```mermaid
---
config:
  flowchart:
    nodeSpacing: 16
    rankSpacing: 8
    padding: 8
    subGraphTitleMargin:
      top: 8
      bottom: 12
---
flowchart TB
  accTitle: Responsibilities in a Skein-hosted agent
  accDescr {
    You define the state schema, nodes, and edges and choose the models, prompts, and tools.
    LangGraph.js executes the graph, handles interrupts, writes checkpoints, and emits stream events.
    Skein hosts the graph and provides the API, runs, threads, storage, stream delivery, schedules, and callbacks.
  }
  subgraph hosting["<b>Skein hosts it</b>"]
    direction TB
    hostingServices@{ shape: text, label: "API · runs · threads<br/>Storage · stream delivery<br/>Schedules · callbacks" }
    subgraph execution["<b>LangGraph.js executes it</b>"]
      direction TB
      executionFeatures@{ shape: text, label: "Interrupts · checkpoints<br/>Stream events" }
      authoredGraph["<b>You define the graph</b><br/>State schema · nodes · edges<br/>Models · prompts · tools"]
      executionFeatures ~~~ authoredGraph
    end
    hostingServices ~~~ execution
  end
  classDef details fill:none,stroke:none
  class hostingServices,executionFeatures details
  class authoredGraph accent
```

Read it through once; after that it is a map — find the pressure you are under and follow the link.

## The model and the prompt — yours

skein never sees your model choice. You construct it in your graph, from any LangChain provider, and
your key lives in `.env`.

One habit worth forming early: keep raw data in state and format the prompt inside the node. State is
checkpointed every step, so a rendered prompt in a channel is a copy you pay for on every turn.

→ [Your first agent](./your-first-agent.md#5-give-it-a-real-model)

## Tools — yours

A function plus the metadata the model reads to decide when to call it. That metadata is the model's
_only_ context for the decision, so write it for someone who knows nothing else.

**The trap:** a failing tool does not fail the run. The error goes back to the model, which will
often try again. Bound that in the graph, not in hope.

→ [LangGraph essentials](./langgraph-essentials.md#tools)

## Control flow — LangGraph's

You define the graph's state, nodes, and edges. LangGraph executes the nodes and follows the edges
to decide what runs next. In an agent loop, an edge can route execution back to the model. Skein
hosts the compiled graph, which also runs on LangGraph Platform.

→ [LangGraph essentials](./langgraph-essentials.md)

## A run is one turn

One input, one execution of your graph. What differs is how you wait: hold the connection, stream, or
take an id and let it work.

Two surprises. A run is not tied to the connection that started it — drop the stream and it keeps
going. And a second message mid-run does not queue: the default strategy is `reject`, which fails the
_second_ run with a 422 and leaves the first alone.

→ [Runs](./runs.md)

## Checkpoints, and everything they buy

Use checkpoints when a conversation must continue from saved state, pause for approval, or branch
from an earlier point. Inspect them in the [console](./console.md#time-travel) to test those paths.

LangGraph writes checkpoints after each superstep through the checkpointer Skein configures.

```mermaid
flowchart LR
  CP[checkpoint at each<br/>node boundary]
  CP --> A[multi-turn<br/>conversations]
  CP --> B[pause for<br/>a human]
  CP --> C[time travel<br/>fork a past turn]
  CP --> D[crash<br/>recovery]
  class CP accent
```

> [!WARNING]
> Conversation state and interrupt/resume require a checkpointer. `skein dev`, `embedInMemoryGraphs`,
> and `embedPostgresGraphs` configure one for you. Call `.compile()` without passing a checkpointer
> so Skein can supply the one for your deployment.

A related trap arrives with it. A run carries four bags — `input`, `context`, `config.configurable`,
`metadata` — and only `input` becomes state the agent remembers.

→ [State, context & persistence](./state-and-context.md)

## Threads: one conversation

A thread is the state plus every checkpoint behind it. Address one by a key you already have — a
ticket number, a phone number — and your system needs no mapping table.

→ [Threads](./threads.md)

## Memory: what outlives the conversation

A thread remembers a conversation, not a person. Two stores, two lifetimes:

|                  | Scope                                      | Written by                |
| ---------------- | ------------------------------------------ | ------------------------- |
| **Checkpointer** | One thread                                 | LangGraph, each superstep |
| **Store**        | Namespaces you choose, across every thread | Your nodes, explicitly    |

**The trap:** a user's name in the thread. They start a new conversation and the agent has forgotten.
Facts about a person go in the store; facts about this conversation stay in state.

→ [Memory](./memory.md) · [Storage](./storage.md)

## Pausing for a human

The moment your agent can spend money or send email, someone will want to be asked first. `interrupt()`
_ends the run_ on a checkpoint — no connection held, no timer, nothing billed while it waits. Approval
comes an hour or a week later and the graph resumes where it stopped.

A pause that cannot survive a redeploy is not worth much, which is why this is the feature that most
often justifies durable storage on its own.

→ [Human-in-the-loop](./human-in-the-loop.md)

## Watching it think

Runs stream over server-sent events, and LangGraph's stream modes map onto the wire unchanged — which
is why `useStream` works against a skein server with a URL change and nothing else. A dropped stream
reconnects and joins the same run.

→ [Streaming](./streaming.md) · [Frontend SDKs](./react-sdk.md)

## Work that outlives the request

Not everything is a chat turn.

- [Background jobs](./background-jobs.md) — hand it over, get an id
- [Crons](./crons.md) — schedule runs across your server instances
- [Webhooks](./webhooks.md) — your service told when a run settles

The webhook contract is worth reading twice: delivery is durable, committed in the same transaction
as the run's terminal status, but **at-least-once**. Dedupe on `X-Skein-Delivery-Id` and answer `2xx`
only once your own work is committed.

## Config without a redeploy

An **assistant** is a named, versioned configuration of one graph. Ship a prompt change as a version,
roll it back in one call, graph untouched.

→ [Assistants](./assistants.md)

## Knowing what it did

Connect LangSmith, PostHog, or OpenTelemetry to inspect your agent's production runs in a backend
you already use.
For a local investigation, first inspect the run's output and state in the [console](./console.md#runs).

What skein does not do is judge the output — that is LangSmith or your own harness. Its job is making
every run recorded and replayable.

→ [Observability](./observability.md) · [Errors & logging](./errors-and-logging.md)

## Where this lives in production

The default development server uses memory drivers. Durable deployment is a choice: SQLite for
one local Node owner, or Postgres/Redis for a shared server. They provide different capabilities:

|              | Buys you                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------- |
| **Postgres** | State, checkpoints, threads, runs, memories and pending webhooks across a restart                  |
| **Redis**    | A shared durable run queue and streaming across instances                                          |
| **SQLite**   | Local resources, checkpoints, unclaimed queued jobs, and delivery outbox records in one owned file |

Your graph code is identical either way — drivers are injected, not imported.

SQLite records abandoned attempts as failures; applications choose whether to retry or resume.
Redis retains its existing stalled-job redelivery behavior. Delivery retries poll the store's
outbox and do not require Redis.

→ [Storage](./storage.md) · [Local deployment](./local-deployment.md) · [Runs & Redis](./runs-and-redis.md) · [Deploy](./deploy.md)

## What was yours all along

You define the graph and choose its models, prompts, and tools. LangGraph executes the graph.
Skein hosts it and provides the API, run management, and storage.

Want it as a lookup table instead of a story? [Features](./features.md). Want the graph model itself?
[LangGraph essentials](./langgraph-essentials.md).
