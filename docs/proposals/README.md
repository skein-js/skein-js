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

One round trip needs no browser: the outbound leg has to be trustworthy (the answer gets back) and
the inbound leg has to be cheap (the event gets in). **The outbound half shipped**, so one proposal
remains.

| Proposal                                 | Summary                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [inbound-events.md](./inbound-events.md) | **The goal.** An optional inbound pipeline plus a plugin interface, so a source is one small file |

### Shipped: durable outbound delivery

A run's completion notification could be lost with no record and no retry — a defect in the server
whether or not anything was built on top of it. It now survives a receiver outage, a redeploy and a
crash, and receivers can authenticate it. Read
[recipes/production.md](../recipes/production.md#get-notified-when-a-run-finishes) and
[langgraph-cli-compat.md](../langgraph-cli-compat.md#webhooks-skeinwebhooks) to use it.

The proposal itself is gone from this directory, because this directory is for work that is not yet
built. What is worth keeping is what the implementation **rejected**, since each was argued for in
the design and turned out to be wrong:

- **The stated problem was wrong.** The proposal argued from "webhooks are best-effort and unsigned",
  but `webhookDispatcher` was already injectable — an embedder could roll retries, signing and
  allowlists themselves. Two things survived scrutiny and justified the work: `buildRuntime` has no
  override seam at all, so every CLI deployment can inject _nothing_; and nobody, in any persona, can
  close the crash window between the terminal status write and the first line of a caller's
  dispatcher, because it opens before caller code runs.
- **A conditional delivery insert.** Making the insert conditional on winning the finalize would have
  forced the cancel paths to enqueue deliveries too, and opened a window where a cancel that beats the
  engine notifies nobody. The insert is unconditional inside a conditional finalize, so the cancel
  paths are untouched; a `run_status` column carries whichever status actually committed.
- **`secrets.path`, and a global `GET /webhook-deliveries` with its own `RouteGroup`.** An embedder
  already has a more expressive hook than the proposed `WebhookSecrets` interface, and a route group
  is a member of a closed union that can never be withdrawn. The delivery routes are run-scoped
  instead, which keeps a global list purely additive.
- **A retry worker of our own.** On Redis the whole schedule — delayed jobs, exponential backoff with
  jitter, stalled-job recovery — is BullMQ's. In-memory is a development driver, and a design
  constrained by what it can do under-serves every real deployment. Our polling loop survives as that
  development path and as the recovery sweep for the one gap a queue cannot cover: a crash between the
  outbox COMMIT and the enqueue, since a Redis `add()` cannot join a Postgres transaction.

Three things these used to depend on have since shipped, which is why the round trip is now buildable
at all. **Idempotent run creation** (`Idempotency-Key`) landed in 0.14 as this proposal's first phase
— see [agent-protocol.md](../agent-protocol.md#idempotent-run-creation-idempotency-key). And
[#7](https://github.com/skein-js/skein-js/issues/7), where SDK thread/run options (`if_exists`,
`if_not_exists`, `after_seconds`) were silently ignored, shipped in 0.13.1 — those are the primitives
an external service needs to address a conversation it did not create, and `if_exists` making thread
creation idempotent by construction is why `Idempotency-Key` ended up runs-only.

`inbound-events` remains a genuine **bet**, and its phase 1 is explicitly allowed to kill it: write
the WhatsApp example against raw primitives with no pipeline at all, and if it comes out short, ship
only the helpers and stop.

## How to read these

These are **not user documentation**. They describe intent, not behaviour — nothing here is shipped
until it appears in [`docs/roadmap.md`](../roadmap.md) as done, and none of these files are part of
the [`llms-full.txt`](https://github.com/skein-js/skein-js/blob/main/llms-full.txt) bundle (that list is curated in
`scripts/generate-llms-full.mjs` and covers user-facing docs only). When a proposal ships, the
durable explanation moves into a real doc and the proposal becomes history.

Each carries its own **non-goals** and **open questions** sections. Those are the load-bearing parts:
a proposal that only argues for itself is a pitch, not a design.

Contributors working in this repo can run that argument mechanically: `/audit-plan` audits a proposal
against the shipped API before any of it is built, asking of each capability whether it is the
library's problem or the user's, whether the primitives to solve it already exist, and what permanent
public surface it would commit us to.
