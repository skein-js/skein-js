# Building blocks

Every agent starts the same way: a model, a prompt, and a loop. That version works, and it works on
your laptop, and for about a day it is genuinely all you need. What follows is the story of what
reality adds to it — each piece arriving because something broke without it, and each one either
yours to write, LangGraph's to define, or skein's to run.

Read it end to end the first time. After that it is a map: find the pressure you are under, and
follow the link.

## It starts with a model and a prompt

This part is yours, and skein has no opinion about it. You construct a model in your graph — any
LangChain provider package — and your key lives in `.env`. Nothing in skein sees which model you
picked or what you asked it.

The one piece of advice worth taking early is about where the prompt lives. Keep raw data in state
and format the prompt inside the node that calls the model. Everything you put in state gets written
to durable storage on every step, so a fully-rendered prompt sitting in a channel is a copy you pay
for on every turn, forever. [Your first agent](./your-first-agent.md#5-give-it-a-real-model) walks
through wiring the first one.

## Then it needs to do something

A model that only talks is a chat window. Tools are what make it an agent: a function, plus the
metadata the model reads to decide when to call it. That metadata is doing more work than it looks
like — the description and the argument schema are the model's _only_ context for that decision, so
write them for someone who knows nothing else, because that is exactly the model's situation.

The surprise here is what happens when a tool throws. The run does not fail; the error goes back to
the model, which will often cheerfully try again. If that matters — and with anything that costs
money or sends email, it does — bound it in your graph rather than hoping.
[LangGraph essentials](./langgraph-essentials.md#tools) has the shape of one.

## Then it needs to decide

Two tools become a choice, and a choice becomes a graph. Nodes are plain functions; edges say what
runs next; conditional edges branch on state, and cycles are not just allowed but expected — the
agent loop _is_ a node that routes back to the model until there is nothing left to call.

This is LangGraph's, entirely. skein serves whatever you compile and wraps none of it, which is why
the same graph runs unchanged on LangGraph Platform. If the graph model is new to you,
[LangGraph essentials](./langgraph-essentials.md) is the short version, with a link out to the
LangChain docs on each concept.

## Then someone sends a second message

Your first real user does something your tests never did: they send another message while the first
one is still running. Something has to give, and skein makes you say what.

The default is `reject` — the second run fails with a 422 and the first is left alone. That is
usually right, because a second message usually means a double-click. When it doesn't, you pick
`interrupt`, `rollback` or `enqueue` per run. It is also worth knowing that a run is not tied to the
connection that started it: the client can drop the stream, close the tab, and the run keeps going.
[Runs](./runs.md) covers all four strategies, cancelling, and timeouts.

## Then they come back tomorrow

Here is where most homegrown agent servers start hurting, because the thing users expect — that the
conversation is still there — is not something a request handler can give them.

LangGraph saves your state to a **checkpoint** at every node boundary, and skein persists those
checkpoints. That single mechanism is not one feature, it is four: multi-turn conversations resume
from the last checkpoint rather than starting empty; a paused run has somewhere to park; every past
checkpoint stays addressable, so you can fork one and re-run a turn differently; and a process that
dies mid-run leaves committed state behind.

Everything else on this page leans on it, which is why the failure mode is so nasty: **with no
checkpointer, none of the above happens and nothing warns you.** Runs just start empty and resume
quietly does nothing. `skein dev` configures one for you, as do `embedInMemoryGraphs` and
`embedPostgresGraphs` — the mistake is constructing your own and handing it to `.compile()`.
[State, context & persistence](./state-and-context.md) is the page that matters most here.

A related trap arrives at the same time. A run carries four separate bags — `input`, `context`,
`config.configurable` and `metadata` — and only `input` becomes state the agent remembers. Putting a
fact in `context` and expecting it next turn is the classic mistake.

Conversations themselves are **threads**: the state, plus every checkpoint behind it. You can let
skein mint the ids or address a thread by a key you already have — a ticket number, a phone number —
so your system needs no mapping table of its own. [Threads](./threads.md) covers reading, forking,
searching and expiring them.

## Then they expect it to remember _them_

A thread remembers a conversation. It does not remember a person. The user who told you last week
that they prefer Celsius starts a new conversation and the agent has forgotten, because that fact
was in the wrong place.

So there are two stores with two lifetimes. The checkpointer holds one thread's state and is written
for you on every step. The **store** holds whatever you put in it, under namespaces you choose,
across every thread — read and written explicitly from your nodes, with semantic search and expiry.
Facts about a person go there; facts about this conversation stay in state. [Memory](./memory.md)
covers the patterns, including the deduplication trap that makes naive memory writes accumulate
near-duplicates until recall degrades.

## Then something needs approving

The moment your agent can spend money, send email, or touch production, someone will want to be
asked first. This is where the checkpoint work pays off.

Calling `interrupt()` inside a node _ends the run_ on a checkpoint. Nothing holds a connection,
nothing holds a timer, nothing is billed while it waits. A human approves an hour later — or a week
later, from a different machine, after a redeploy — and the graph resumes from exactly where it
stopped. A pause that could not survive a redeploy would not be worth much, which is why this is the
feature that most often justifies durable storage on its own.
[Human-in-the-loop](./human-in-the-loop.md) has both halves.

## Then people want to watch it think

Nobody waits thirty seconds at a blank screen. Runs stream over server-sent events, and LangGraph's
stream modes — values, updates, messages, custom — map onto the wire unchanged, which is why
`useStream` and the LangChain SDKs work against a skein server with a URL change and nothing else. A
dropped stream is recoverable: reconnect and join the same run, from the same client or a second
one. [Streaming](./streaming.md), and [frontend SDKs](./react-sdk.md) for the client half.

## Then the work outgrows the request

Not everything is a chat turn. Some work should be handed off and reported on later; some should run
on a schedule nobody triggers; some belongs to another system entirely that just wants to be told
when it is done.

skein does all three: [background jobs](./background-jobs.md) that hand you an id immediately,
[crons](./crons.md) that fire exactly once across every instance with no leader election, and
[run-completion webhooks](./webhooks.md) that call your service when a run settles. The webhook is
the one with a contract worth reading twice — delivery is durable, committed in the same transaction
as the run's terminal status, but it is **at-least-once**. Dedupe on `X-Skein-Delivery-Id` and answer
`2xx` only once your own work is committed. A callback is a notification; the API stays the source of
truth.

## Then you want to change the prompt without a deploy

Prompts change more often than code does, and shipping a container to reword a sentence gets old.
An **assistant** is a named, versioned configuration of one graph — a prompt, a model choice, a set
of knobs. Create a version to ship a change, and roll it back in a single call, with the graph code
untouched. [Assistants](./assistants.md).

## Then it misbehaves and you cannot see why

An agent that works in a demo and does something baffling in production is the normal case, not the
exception, and you cannot debug what you cannot see. skein emits run lifecycle and model-call
telemetry through a sink interface, with implementations for LangSmith, PostHog and OpenTelemetry,
so the traces land in a backend you already operate rather than one you have to adopt.

What skein does not do is judge the output. Whether the answer was any _good_ is a question for
LangSmith or an evaluation harness of your own; skein's job is making sure every run was recorded
and can be replayed when you go looking. [Observability](./observability.md), and
[errors & logging](./errors-and-logging.md) for what a failed run reports and where.

## Then it has to survive a restart

Development is entirely in memory, and it is meant to be — zero setup, nothing to install, gone when
you exit. Production is Postgres and Redis, and they buy different things. Postgres keeps state,
checkpoints, threads, runs, memories and pending webhooks across a restart. Redis gives you a
durable run queue, retry schedules that outlive a deploy, and streaming that works when more than
one instance is serving.

Your graph code is identical either way, because the drivers are injected rather than imported —
which is the whole reason the in-memory path is safe to develop against. [Storage](./storage.md),
[runs & Redis](./runs-and-redis.md), and [deploy](./deploy.md) when you are ready to ship it.

## What was yours all along

Read back over it and the split is clean. The model, the prompt and the tools are yours — they are
the reason your agent is _your_ agent, and nothing here replaces them. The graph is LangGraph's:
state, nodes, edges, interrupts, stream modes, unchanged and unwrapped. Everything else — threads,
runs, memory, schedules, callbacks, versioned config, telemetry, and the durability under all of it
— is the plumbing skein exists so that you do not write.

If you want the same ground as a lookup table instead of a story, [features](./features.md) has every
capability in one page. If the graph model itself is the part you want to go deeper on, that is
[LangGraph essentials](./langgraph-essentials.md).
