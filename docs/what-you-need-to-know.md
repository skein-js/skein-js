# What you need to know

You have an agent running. This page is the map of everything [the tutorial](./your-first-agent.md)
skipped: the parts you meet the moment your agent does something real, what each one is for, and
which page owns the details. Nothing here is deep — every section hands off after a few lines.

If you read only three of them, read **what the agent knows**, **checkpoints**, and **where all
this lives in production**. Everything else is a consequence of those.

## A run is one turn

You give the server an input, it executes your graph once, and that execution is a **run**. What
differs is how you wait for it: hold the connection until it finishes, stream tokens as they are
produced, or take an id back immediately and let it work.

Two things surprise people. A run is not tied to the connection that started it — drop the stream
and the run keeps going. And a second message arriving mid-run does not queue by default: the
default [multitask strategy](./runs.md#multitask-what-happens-to-the-run-already-going) is `reject`,
which fails the _second_ run with a 422 and leaves the first alone. Queueing, interrupting and
rolling back are all available — you just have to ask.

→ [Runs](./runs.md) — every mode, cancelling, timeouts, deferred starts

## What the agent knows

A run carries four separate bags, and only one of them is remembered:

| You pass              | Persisted?                     |
| --------------------- | ------------------------------ |
| `input`               | **Yes** — it becomes state     |
| `context`             | No — this run only             |
| `config.configurable` | No — this run only             |
| `metadata`            | Yes, but as a searchable label |

**The trap:** putting a fact in `context` and expecting the agent to still know it next turn. If it
should survive the turn, it belongs in `input`.

→ [State, context & persistence](./state-and-context.md) — what each bag is for, and reducers

## Checkpoints: why anything survives at all

LangGraph saves your state at every node boundary. That one mechanism is what buys multi-turn
conversations, human-in-the-loop, time travel and crash recovery — they are not four features, they
are four consequences of the same thing.

> [!WARNING]
> **No checkpointer, none of the above.** Each run starts empty, `interrupt()` has nowhere to park,
> and resuming silently does nothing. `skein dev` configures one for you, as do
> `embedInMemoryGraphs` and `embedPostgresGraphs` — the mistake is constructing your own instead.

→ [Checkpoints](./state-and-context.md#checkpoints-what-makes-everything-else-work)

## Threads: one conversation

A **thread** is a conversation: the state, and every checkpoint behind it. You can let the server
mint thread ids, or address one by a key you already have — a ticket number, a phone number — so
your system needs no mapping table of its own.

Because every checkpoint is addressable, you can fork one and run forward from the branch. That is
"edit and resubmit", and it is the same mechanism as everything above.

→ [Threads](./threads.md) · [Time travel](./threads.md#time-travel-re-run-a-turn-a-different-way)

## Memory: what outlives the conversation

Two stores, two lifetimes. The **checkpointer** holds one thread's state and history, written for
you on every step. The **store** holds whatever you put in it, under namespaces you choose, across
every thread — read and written explicitly from your nodes, with semantic search and TTL.

**The trap:** keeping a user's name in the thread. They start a new conversation and the agent has
forgotten who they are. Facts about a _person_ go in the store; facts about _this conversation_ go
in state.

→ [Memory](./memory.md) — profile vs collection shapes, the dedup trap, recall ·
[Storage](./storage.md) — the drivers underneath, and bringing your own

## Pausing for a human

Call `interrupt()` inside a node and the run **ends** on a checkpoint. Nothing holds a connection,
nothing holds a timer, nothing is billed while it waits. Someone approves an hour or a week later,
you resume with a command, and the graph carries on from where it stopped.

This is the feature that most often justifies durable storage, because a pause that cannot survive
a redeploy is not a pause.

→ [Human-in-the-loop](./human-in-the-loop.md)

## Watching it happen

Runs stream over server-sent events. LangGraph's stream modes — values, updates, messages, custom —
map onto the wire unchanged, so the LangChain SDKs and `useStream` work against your server with a
URL change and nothing else.

A dropped stream is recoverable: reconnect and join the same run, from the same client or a second
one.

→ [Streaming](./streaming.md) · [Frontend SDKs](./react-sdk.md)

## Work that outlives the request

Not everything is a chat turn. Hand skein a job and get an id back; run a graph on a schedule; be
told when a run finishes by an HTTP callback to your own service.

**The trap:** treating a webhook as a ledger. Delivery is durable but **at-least-once** — dedupe on
`X-Skein-Delivery-Id` and answer `2xx` only once your work is committed. The API stays the source of
truth for run state.

→ [Background jobs](./background-jobs.md) · [Crons](./crons.md) · [Webhooks](./webhooks.md)

## Configuration without a redeploy

An **assistant** is a named, versioned configuration of one graph — a prompt, a model choice, a set
of knobs. Ship a prompt change by creating a version, and roll it back in one call. Your graph code
does not move.

→ [Assistants](./assistants.md)

## Where all this lives in production

Development is entirely in-memory and is **only** for development. Production is Postgres and
Redis, and they buy different things:

|              | Buys you                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------- |
| **Postgres** | State, checkpoints, threads, runs, memories and webhook rows that survive a restart          |
| **Redis**    | A durable run queue, retry schedules, and streaming that works across more than one instance |

Your graph code is identical either way — the drivers are injected, not imported.

→ [Storage](./storage.md) · [Runs & Redis](./runs-and-redis.md) · [Deploy](./deploy.md)

## Where to go next

- [Features](./features.md) — the same ground as a capability table, with what ships and what
  doesn't
- [LangGraph essentials](./langgraph-essentials.md) — the graph model underneath all of this, and
  where to go deep on it
