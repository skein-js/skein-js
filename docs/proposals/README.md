# Proposal — Beyond LangGraph Platform

Design documents for work that is **not yet built**. Each proposal states the problem, what we hope
to achieve, what we explicitly won't do, and a design sketch concrete enough to argue with.

## The thesis

Almost every agent framework assumes the agent lives behind a **web chat UI**. LangGraph's whole
client ecosystem is browser-shaped — [`useStream`](../react-sdk.md), Agent Chat UI, LangGraph Studio.
A human opens a tab, types, and watches tokens stream back. skein-js already serves that path as well
as LangGraph Platform does; the [roadmap](../roadmap.md) parity table is nearly all green.

But a browser tab is a small slice of where agents belong. Most software has no human staring at one:

- A **WhatsApp number** — for an enormous share of the world, chat _is_ the interface, and there is no
  app to install.
- An **inbox** that answers support email in the thread the customer already started.
- A **GitHub webhook** that triages an issue and comments back.
- A **Stripe dispute** that drafts a response before anyone reads it.
- A **Slack workspace** where the agent is a colleague rather than a website.
- Any **service-to-service call** where the caller is another program and the "conversation" is an
  event stream.

The moment an agent leaves the browser, the guarantees stop. The run is durable; the news that it
finished is not. Nothing is idempotent, so every retrying provider double-fires and the user gets two
replies. There is no way to map an external identity — a phone number, an email thread — onto a
conversation. And human-in-the-loop, which works beautifully when the human is watching a stream,
silently breaks when the human answers six hours later by text.

**That is the gap these proposals close.** Not catching up to LangGraph Platform — going where it
hasn't. Both capabilities are genuinely absent from LangGraph: diffing `@langchain/langgraph-sdk`
v1.9.25 turns up zero hits for idempotency, and `webhook` is a bare URL string with no signing, no
retries, and no delivery record.

It is also the right bet for a **self-hosted** project specifically. People who self-host are people
integrating with infrastructure they already own — their own queues, their own numbers, their own
inboxes. They are not the audience for a hosted chat widget.

## The proposals

Together they form one round trip that needs no browser: **durable-delivery** makes the outbound leg
trustworthy (the answer gets back), **inbound-events** makes the inbound leg cheap (the event gets
in).

| Proposal                                     | Status        | Summary                                                                                                                                |
| -------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [durable-delivery.md](./durable-delivery.md) | Partly landed | Idempotent run creation **shipped**; durable, signed, retried run-completion delivery still planned                                    |
| [inbound-events.md](./inbound-events.md)     | Draft (rev 2) | A generic, optional inbound event pipeline — plugin interface plus three capped first-party sources                                    |
| [long-term-memory.md](./long-term-memory.md) | Resolved      | Traversal, BYO store and per-owner scoping shipped; the shapes became a recipe ([memory.md](../memory.md)) and the trigger is deferred |

**The two statuses differ in kind, not just maturity.** `durable-delivery` closed a gap that already
existed and already bit, and its open questions were about _how_, not _whether_. Its **phase 1
(idempotent run creation) has shipped** — see
[agent-protocol.md](../agent-protocol.md#idempotent-run-creation-idempotency-key). What remains is the
outbound half: today a run's completion notification can still be lost with no record and no retry,
which is a defect in the server whether or not anything is ever built on top of it. `inbound-events`
is a genuine **draft** — a design bet that phase 1 is explicitly allowed to kill.

Both depended on [#7](https://github.com/skein-js/skein-js/issues/7), a parity bug where SDK
thread/run options (`if_exists`, `if_not_exists`, `after_seconds`) were silently ignored — the
primitives an external service needs to address a conversation it did not create. **That shipped in
0.13.1**, which is also why `Idempotency-Key` is runs-only: `if_exists` already makes thread creation
idempotent by construction.

Read `durable-delivery` first. It is independently valuable and independently shippable, and it is
the honest baseline `inbound-events` has to beat.

## How to read these

These are **not user documentation**. They describe intent, not behaviour — nothing here is shipped
until it appears in [`docs/roadmap.md`](../roadmap.md) as done, and none of these files are part of
the [`llms-full.txt`](../../llms-full.txt) bundle (that list is curated in
`scripts/generate-llms-full.mjs` and covers user-facing docs only). When a proposal ships, the
durable explanation moves into a real doc and the proposal becomes history.

Each carries its own **non-goals** and **open questions** sections. Those are the load-bearing parts:
a proposal that only argues for itself is a pitch, not a design.
