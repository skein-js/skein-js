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

_Nothing here is currently unbuilt._ One round trip needs no browser: the outbound leg has to be
trustworthy (the answer gets back) and the inbound leg has to be cheap (the event gets in). **Both
halves have now shipped**, so what this file holds is the record of what each implementation
**rejected** — which is the half worth keeping, because a design is only tested by building it.

### Shipped: inbound channels

An agent behind any inbound event — a WhatsApp number, a Slack workspace, a GitHub webhook. Read
[channels.md](../channels.md) to use it.

Its phase 1 was explicitly allowed to kill it: write the WhatsApp example against raw primitives with
no pipeline at all, and if it came out short, ship only the helpers and stop. It did not — but the
reason to proceed was **not** the one predicted. The hand-written version was 334 lines against a
"under 60" target, and the pipeline brought it to 65, which is a near miss rather than a win. What
justified the work was that three of the seven steps could not be made _correct_ from user code at
all, and each failed silently: a start that discarded a pending question
([#35](https://github.com/skein-js/skein-js/issues/35)), a question unreachable from the callback
([#36](https://github.com/skein-js/skein-js/issues/36)), and a retry refused for having done the
right thing. All three shipped as defect fixes in their own right.

What the implementation **rejected**, each argued for in the design and each wrong:

- **`EventSource` as a name.** It ships as **`Channel`** — the word people already use for putting an
  agent on WhatsApp, and the one Twilio, Intercom and Zendesk use. The _payload_ stayed
  `InboundEvent`, so `from`/`to`/`body`/`typing` are still absent from the core types and a GitHub
  webhook is still the same pipeline. Four other meanings of "channel" already existed in the repo
  (`RunAbortChannel`, Redis pub/sub, LangGraph state channels, `stream_mode: "custom"`); only one is
  public API and it is prefixed, so the collision was a discipline problem rather than a semantic one.

- **`onExisting` as merely a better default.** It was specified as a policy with a sensible default.
  That is not enough: nothing on the server enforced it, because `interrupted` is a _terminal_ run
  status. It is now built on `if_thread_status`, a precondition settled inside the driver's atomic
  create — [#35](https://github.com/skein-js/skein-js/issues/35).

- **`replyWith` on the custom stream, as designed.** Unbuildable. Run frames are published to the
  event bus and never persisted, so reading a declared reply from the stream loses it on exactly the
  crash the outbox exists to survive. It became an engine-side capture into the delivery payload —
  [#36](https://github.com/skein-js/skein-js/issues/36).

- **Five `RunSignal` kinds.** `accepted`, `interrupted` and `settled` were cut: the acknowledgement is
  already the HTTP response, the interrupt now arrives durably in the callback, and the motivating
  provider's indicator clears itself when the reply lands, so `settled` had no call to make. Only
  `progress` and `keepalive` shipped.

- **A new `RouteGroup`.** A group is a member of a closed union that can never be withdrawn, and it is
  1:1 with LangGraph's `http.disable_*` flags — so `"channels"` would have needed a skein-only
  `disable_channels` in the _un-namespaced_ `http` block. The routes are appended only when a channel
  is configured, which is strictly stronger than a disable flag.

- **`rawBody` as the hard part of the transport work.** Twilio signs the URL plus _parsed_, sorted
  params, so the motivating provider never needed raw bytes. The genuinely hard half was the **public
  URL**, and nothing in the repo resolves one — the one place that considered it refused, calling
  `x-forwarded-proto` spoofable. It became configuration. What the transports actually needed was for
  a form-encoded body to arrive at all: Fastify 415'd it before any handler ran.

- **A `skein+channel://` URL the caller could name.** The first delivery design keyed the dispatcher
  on a URL scheme — reachable from the caller-supplied `webhook` field, since `z.string().url()`
  accepts any scheme. That would have let a run create deliver an attacker's message through someone
  else's provider account. `webhook` is now restricted to `http(s)` at the schema, which is the only
  boundary that can tell a caller-supplied URL from a server-derived one.

- **"Resume with the same `input`."** `input` is a graph _input envelope_; `interrupt()` returns
  whatever the node asked for, usually a scalar. Handing a message-shaped graph its own envelope makes
  the node read nonsense. `InboundEvent.resumeWith` says which is which, and skein still coerces
  nothing.

- **Under 60 lines.** The Twilio integration came out at **65**, against a 334-line hand-written
  baseline. The line count was never the strongest argument: three of the seven steps could not be made
  _correct_ from user code at all, and each failed silently.

### Shipped: durable outbound delivery

A run's completion notification could be lost with no record and no retry — a defect in the server
whether or not anything was built on top of it. It now survives a receiver outage, a redeploy and a
crash, and receivers can authenticate it. Read
[webhooks.md](../webhooks.md) and
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

## How to read these

These are **not user documentation**, and while a proposal is open they describe intent rather than
behaviour — nothing is shipped until it appears in [`docs/roadmap.md`](../roadmap.md) as done. None of
these files are part of
the [`llms-full.txt`](https://github.com/skein-js/skein-js/blob/main/llms-full.txt) bundle (that list is curated in
`scripts/generate-llms-full.mjs` and covers user-facing docs only). When a proposal ships, the
durable explanation moves into a real doc and the proposal becomes history.

Each carries its own **non-goals** and **open questions** sections. Those are the load-bearing parts:
a proposal that only argues for itself is a pitch, not a design.

Contributors working in this repo can run that argument mechanically: `/audit-plan` audits a proposal
against the shipped API before any of it is built, asking of each capability whether it is the
library's problem or the user's, whether the primitives to solve it already exist, and what permanent
public surface it would commit us to.
