# Shipped — inbound channels

> **This proposal shipped**, as [`docs/channels.md`](../channels.md) and `@skein-js/channels`. The
> durable explanation lives there; what is kept here is what the implementation **rejected**, because
> each was argued for in the design and turned out to be wrong.
>
> See [proposals/README.md](./README.md) for why this directory works that way.

## What the implementation rejected

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

---

<details>
<summary>The original proposal, kept for the argument it makes</summary>

# Proposal — Inbound events: agents behind WhatsApp, Slack, and anything else

> **Status:** Phase 1 done — proceed, with the justification rewritten · **Depends on:** nothing —
> durable outbound delivery, its one prerequisite, [has shipped](../webhooks.md)
>
> A design proposal, not shipped behaviour. See [proposals/README.md](./README.md).
>
> The kill test has been run:
> [`examples/whatsapp-typing`](https://github.com/skein-js/skein-js/tree/main/examples/whatsapp-typing)
> builds all seven steps by hand with no pipeline. Read
> [**Phase 1 result**](#phase-1-result--the-example-is-built-and-the-kill-condition-did-not-fire) and
> [**What we need to build**](#what-we-need-to-build) first — they supersede parts of the design
> below, and each correction is marked inline.

## Problem

You run a skein server and want a WhatsApp number that talks to your agent. Twilio POSTs you an
inbound message; the agent's reply goes back to that number. Today you write, by hand:

1. A route that verifies `X-Twilio-Signature`.
2. A dedup check on `MessageSid`, because retried deliveries happen.
3. A mapping from `whatsapp:+254…` to a thread, created if absent.
4. A branch on thread status — if a run is `interrupted` waiting for a human, this message must
   **resume** it with a `Command`, not start a new run. Get this wrong and human-in-the-loop over an
   async channel silently doesn't work.
5. A mapping from Twilio's form-encoded body to your graph's input shape.
6. A reply path that turns the run's final state into a Twilio call without double-sending on retry.

And if the agent takes twenty seconds, the user stares at a dead chat window — so you also wire a
typing indicator, from a different part of the system.

**Steps 1–4 and 6 are identical for every provider anyone will ever integrate.** Only step 5, and the
recipe inside step 1, are about Twilio. Yet all of it is the user's problem, re-solved per
integration, with the interesting failures — double-reply, lost reply, an interrupt that never
resumes — landing in front of end users rather than in a test.

## Goals

- **G1 — One integration ≈ one small file.** Tens of lines of glue, not hundreds of plumbing.
- **G2 — The hard parts are ours, once.** Dedup, thread resolution, resume-vs-start, durable reply,
  run progress and signature primitives live in skein, tested, inherited by every integration.
- **G3 — Generic across integration _kinds_.** The same mechanism serves a GitHub webhook, an inbound
  email and a Stripe event as naturally as WhatsApp.
- **G4 — A real plugin surface.** Anyone can write a source without a PR to this repo; skein ships a
  capped handful so common cases work out of the box.
- **G5 — Entirely optional.** A user who never configures it cannot tell the feature exists.

LangGraph gives you an agent behind an API. This gives you an agent behind **any inbound event**.

**Non-goals.** An unbounded set of first-party sources (three, capped). A declarative no-code mapping
language (deferred — config languages grow into bad programming languages; revisit once several
code-based sources make the shared structure empirical). Outbound-initiated conversations. **Polled
sources** (IMAP, queue consumers) — the pipeline is entered by an inbound HTTP request and there is
nothing to enter it with when you poll; that is closer to the cron scheduler. Chunked streaming of
the answer itself in v1. Media storage — sources carry the provider's URL in metadata and the graph
fetches it. **New storage of any kind.**

## The genericity thesis

Every inbound integration is the same pipeline. One step is genuinely provider-specific:

| Step                                    | Provider-specific?                                 |
| --------------------------------------- | -------------------------------------------------- |
| 1. Verify the request is authentic      | The **recipe** varies; the primitives don't        |
| 2. Deduplicate the provider's retries   | No — only _where_ the event id lives varies        |
| 3. Resolve a stable key to a thread     | No                                                 |
| 4. Start / resume / enqueue / ignore    | No — policy, and it's the same policy everywhere   |
| 5. Map payload ↔ graph input and output | **Yes. This is the integration.**                  |
| 6. Signal progress while the run works  | No — a projection of the existing run event bus    |
| 7. Deliver the reply, durably           | No — the delivery outbox already owns it (shipped) |

**The second half of the thesis: model events, not chat messages.** If the canonical type is an
_event_, the identical pipeline covers `issues.opened` → triage → comment back, a Stripe dispute, an
inbound email. Chat is simply the case where the reply target equals the sender. That only holds if
we **resist chat-specific concepts** — the moment `from`/`to`/`body`/`typing` appear in the core
types, GitHub and Stripe stop fitting. Note typing indicators are supported _without_ a `typing`
concept: skein emits generic progress signals and a chat source decides those mean "typing".

## `EventSource` — the extension point

This becomes public API the moment it is advertised, and third-party packages will depend on it.

Two rules shape it. **Every provider-specific decision is a source's; every correctness-critical one
is ours** — a source cannot opt out of dedup, ordering or durable delivery, because those are the
value. And **no privileged access**: first-party sources import only the public entry point, exactly
like a community source. If `@skein-js/events-twilio` needs an internal, the internal is missing from
the public API.

```ts
export interface EventSource {
  readonly name: string;

  /** Authenticate. Returns the principal it represents, or `false` to reject (401).
      REQUIRED. Runs before any parsing, over the raw bytes. */
  verify(request: InboundRequest): Promise<SourcePrincipal | false>;

  /** Map a verified request to an event, an ignore, or a direct response. The integration. */
  parseEvent(request: InboundRequest): Promise<EventOutcome> | EventOutcome;

  /** Deliver the answer. DURABLE — through the delivery outbox, retried, recorded. */
  deliver?(outcome: RunOutcome, target: ReplyTarget): Promise<void>;

  /** Which run signals this source wants. Omit to receive none and pay nothing. */
  readonly signals?: SignalSubscription;

  /** React to progress — typing indicators, status. BEST-EFFORT: at most once, never
      retried, never blocks the run. Must not send the answer. */
  onSignal?(signal: RunSignal, target: ReplyTarget): Promise<void>;
}

export interface InboundEvent {
  /** Stable external identity → a deterministic thread. `whatsapp:+254…`, `gh:owner/repo#41`. */
  threadKey: string;
  /** Graph input, or a `Command` when resuming. */
  input: unknown;
  /** The provider's own event id. Becomes the `Idempotency-Key` for the run it creates. */
  idempotencyKey?: string;
  /** Where the answer goes. Opaque to skein; handed back to `deliver` and `onSignal`. */
  replyTo?: ReplyTarget;
  /** Optional routing among graphs the deployment opted into via `allowed_assistants`. */
  assistantId?: string;
  metadata?: Record<string, unknown>;
  /** Policy when the thread already has an active or interrupted run. Default: `"resume"`. */
  onExisting?: "resume" | "enqueue" | "interrupt" | "reject";
}
```

**`onExisting: "resume"` as the default is step 4 — the one everybody gets wrong.** An event arriving
at a thread whose run is `interrupted` should resume that interrupt, because a human-in-the-loop
pause on an async channel is exactly what a reply hours later is answering. Making the correct
behaviour the default is most of this proposal's practical value.

> **Corrected by phase 1.** This understated the problem. It is not only that the default is easy to
> get wrong — it is that **nothing on the server enforces it**. `interrupted` is a terminal run
> status, so a plain start on an interrupted thread succeeds and silently discards the pending
> interrupt, and no `multitask_strategy` guards it. `onExisting` must therefore be implemented on
> top of a real precondition ([stage 0.1](#stage-0--the-missing-primitives)), not merely be a
> better-chosen default.

### `InboundRequest` — raw bytes are mandatory

```ts
export interface InboundRequest {
  readonly method: string;
  /** The **public** URL, honouring `X-Forwarded-Proto`/`Host`. */
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  /** Unparsed body. Signatures are computed over these bytes; parsing first destroys them. */
  readonly rawBody: Uint8Array;
  json(): unknown; // lazy, cached views
  form(): Record<string, string>;
  text(): string;
}
```

Two fields carry security weight and neither is negotiable. **`rawBody`** — Slack signs
`v0:{timestamp}:{raw body}`; if a transport adapter parses JSON before `verify` runs, signature
checking becomes _impossible_ and the only option left is to trust the request. Preserving raw bytes
across Express, Fastify, NestJS, Next.js and Fetch is security-critical per-adapter work and the
single largest implementation cost here. **`url` must be public** — Twilio signs HMAC-SHA1 over the
full request URL plus sorted params, so behind a proxy verification fails silently unless forwarding
headers are honoured or a public base URL is configured.

### `parseEvent` outcomes

```ts
export type EventOutcome =
  | { kind: "event"; event: InboundEvent }
  /** Acknowledge and do nothing — 204. Bot echoes, receipts, uninteresting types. */
  | { kind: "ignore" }
  /** Answer synchronously without starting a run. */
  | { kind: "respond"; status: number; headers?: Record<string, string>; body?: unknown };
```

A tagged union rather than `InboundEvent | null` because **`ignore` must be free** (Slack redelivers
your own bot's messages — without cheap `bot_id` filtering the agent replies to itself in a loop) and
because **`respond` is required by real providers**: Slack's very first request is a
`url_verification` challenge that must echo `{"challenge": …}`, slash commands want an immediate
ephemeral response, TwiML is the same shape. A 204 expresses none of them.

### Who decides what the reply is

`parseEvent` maps the payload **in**; something maps the answer **out**, and that direction has a
coupling problem. The source owns provider knowledge; the **graph** owns state shape — whether the
answer is at `state.messages.at(-1).content`, `state.answer`, or `state.draft`. A source that guesses
at state shape stops being reusable across graphs, which breaks the plugin premise.

**So the graph declares its reply.** LangGraph already has the channel — `StreamWriter` /
`stream_mode: "custom"`:

```ts
// inside a node — one reserved key, typed by a helper skein exports
writer(replyWith("Your order ships Tuesday."));
```

Resolution order, applied by the pipeline before `deliver`:

1. The graph declared a reply on the custom channel → use it.
2. Otherwise state carries a `messages` array → the last AI message's content. This is LangGraph's
   `MessagesAnnotation` convention, so ordinary chat agents work with **no graph changes at all**.
3. Otherwise → nothing is sent.

Making step 2 a fallback rather than the contract is the point: the common case costs nothing, and a
graph with custom state has an escape hatch that doesn't involve the source knowing about it.
`interrupted` still delivers, resolved the same way. **`error` deliberately carries no reply** —
whether an end user is told "something went wrong" is a product decision, and leaking internals to a
phone number is the wrong default. One reply per run, last write wins.

### Interrupts — the async human-in-the-loop path

The capability this most uniquely enables, and the only place the graph↔source boundary is crossed
twice. Turn 1: message in → `interrupt()` → question delivered. Hours pass, holding no connection, no
subscription and no timer — only a checkpoint. Turn 2: the reply arrives on the same path as any
event, and `onExisting: "resume"` resumes the run. A source needs no notion of "this is a follow-up".

**Rendering the question** extends the same resolution order, with one difference: if nothing renders,
**log a warning**. A successful run that says nothing is fine; an _interrupt_ that says nothing
strands the conversation permanently — the run waits for an answer to a question nobody was asked.

**Interpreting the answer:** resume with `Command({ resume })` carrying the same `input` the source
would have produced for a new turn. No parsing, no coercion — the graph author wrote `interrupt()`
and is the only party who knows whether the node wants `true`, `"approve"`, or free text.

**When the answer isn't an answer** ("actually, never mind — what's my balance?"), the pipeline still
resumes and the graph decides whether to re-ask, pivot or abandon, because the graph holds the
question. Deployments wanting a blunter rule set `onExisting: "enqueue"`.

Two open questions: a `resume_within` staleness bound (a thread interrupted three weeks ago probably
shouldn't resume because someone texted today — leaning no expiry unless configured, since silently
discarding a pending HITL turn is worse than an odd resume), and multiple pending interrupts, where
v1 resumes the first and logs.

### Run signals — typing, status, progress

```ts
export type RunSignal =
  | { kind: "accepted"; runId: string }
  | { kind: "progress"; runId: string; node?: string; custom?: unknown }
  | { kind: "keepalive"; runId: string }
  | { kind: "interrupted"; runId: string; interrupt: unknown }
  | { kind: "settled"; runId: string; status: RunStatus };

export interface SignalSubscription {
  kinds: readonly RunSignal["kind"][];
  keepaliveMs?: number; // Telegram-style indicators expire in seconds
}
```

**A projection, not new machinery** — skein already fans run output out over `RunEventBus`,
cross-instance via Redis. Declaring a subscription (rather than always-on) lets the pipeline pick the
cheapest stream mode that satisfies it: a source wanting only "keep the indicator alive" shouldn't
pay for token streaming, and a GitHub source should pay nothing.

> **Corrected by phase 1.** The subscription argument held up — the example's indicator discards
> every frame it receives, so paying for token streaming would be pure waste. Two things were wrong.
> `RunEventBus` is **not reachable** from a host on the `{ config }` path, because `ProtocolRuntime`
> exposes no `deps`; the example had to use `runs.joinStream`, one HTTP connection per in-flight
> conversation. And `settled` buys nothing on the motivating provider: Twilio's indicator expires by
> itself and is cleared by delivering the reply, so there is no "stop typing" call to make. Since
> `RunSignal` is permanent public API, justify each kind against a real consumer before it ships.

**`deliver` and `onSignal` are separate methods because they have opposite guarantees** — durable,
at-least-once, retried, replayed from the outbox versus best-effort, at-most-once, lost by design.
Retrying a "typing" signal four minutes later is nonsense; making the answer best-effort defeats the
proposal. Two methods make that impossible to get wrong where one method plus a doc note would not.

## Authentication

**The trap:** Twilio presents `X-Twilio-Signature`, not a bearer token. `resolveAuthContext` invokes
the user's `authenticate` handler, which expects a JWT or API key, and would **401 every inbound
webhook**. The obvious workaround — exempting these routes the way `getServerInfo` is exempted — is
far worse: that exemption is justified because `/info` exposes no content, whereas **event routes
create runs**. An exempt route is an unauthenticated run-creation endpoint bypassing the entire
`Auth` block.

**The fix: `verify()` returns a principal, not a boolean.**

```ts
export interface SourcePrincipal {
  /** e.g. `"source:twilio:+254712345678"` — derived from provider-verified data only. */
  identity: string;
  permissions?: string[];
  metadata?: Record<string, unknown>;
}
```

A provider's signature _is_ an authentication scheme; it just isn't a bearer token. Having it produce
a principal lets the request flow through the **normal** authorization path — `@auth.on.threads`
handlers see it, ownership filters apply, multi-tenancy works because the identity derives from the
provider-verified sender. No bypass anywhere. Consequences, all load-bearing:

- **`verify` is required, not optional.** A provider with no signature scheme must still yield a
  principal some other way — secret path segment, shared-secret query parameter, basic auth. Weaker,
  never absent.
- **The Studio bypass must not apply.** `resolveAuthContext` admits `x-auth-scheme: langsmith`
  without authenticating; on an event route that is one forged header from free run creation. Event
  routes authenticate **only** through `verify()`.
- **Authorization reuses the crons precedent** — `{ resource: "threads", action: "create_run" }`, as
  every run route already does.
- **The route stays inside the handler table.** `ROUTE_AUTHZ` is exhaustive by type, so adding the
  handler won't compile until someone makes an explicit auth decision.

## The pipeline

**Architectural test: a pure composition of primitives that already exist.** If it needs storage of
its own, that is a signal the delivery outbox is incomplete and the gap belongs there, not here.

```
POST /events/:source
  → verify()                    → principal, or 401
  → parseEvent()                → ignore? 204 · respond? that response · else continue
  → idempotencyKey              → replay prior response          [shipped: Idempotency-Key]
  → resolve threadKey           → get-or-create thread           [shipped: if_exists]
  → resolve assistant           → event's, if allowed; else the source's configured one
  → resume | start | enqueue    → per onExisting
  → enqueue run, ACK 2xx        ← invariant
  ├→ onSignal(…)                → best-effort, from RunEventBus  [existing machinery]
  └→ deliver(outcome, replyTo)  → durable, retried, recorded     [delivery outbox]
```

**Invariant: acknowledge after enqueueing, never after the run completes.** Slack requires 2xx within
3 seconds or it retries and shows the user an error; Twilio times out comparably. Background runs
already give us this, but it must be pinned by a test. This is also _why_ run signals exist — the ack
is early, so progress has to arrive out of band.

Registered in `skeinRoutes` with a new `RouteGroup: "events"`, and **absent from the table entirely**
unless a source is configured, which is stronger than disable-able.

## Configuration — `skein.events`

No `skein.json`. skein already reserves a namespace inside `langgraph.json`, and `path:export`
loading is proven three times over — graphs, `auth.path`, telemetry `paths`.

```jsonc
{
  "graphs": { "support": "./src/support.ts:graph", "triage": "./src/triage.ts:graph" },
  "skein": {
    "events": {
      "twilio": {
        "path": "@skein-js/events-twilio", // first-party package
        "assistant": "support", // which graph its events run — REQUIRED
      },
      "github": {
        "path": "./src/github-source.ts:source", // your own, path:export
        "assistant": "triage",
        "allowed_assistants": ["triage", "support"], // opt in to source-side routing
      },
    },
  },
}
```

**`assistant` is required** — the binding is deployment knowledge, not provider knowledge. A
community Twilio adapter has no business knowing you named your graph `support`. It accepts a UUID or
a graph name, resolving exactly as it does for crons.

**Source-side routing is opt-in and bounded.** Real integrations need it — one Slack app serving
`#support` and `#eng` from different graphs. But a source may only reach graphs listed in
`allowed_assistants`; an unlisted `assistantId` is rejected and logged. That bound is the point: a
source is an npm package you installed, and without it any published source could route arbitrary
untrusted input into any graph. Omitting the key means the source cannot route at all.

**Validated at boot, not at first event** — a missing `assistant`, or one naming a graph that doesn't
exist, fails startup with a precise `SkeinConfigError`. Discovering a typo when the first customer
texts is the failure this avoids.

> Two skein-only surfaces already sit _outside_ the namespace: top-level `telemetry` and
> `store.index.hnsw`. If LangGraph ever adds a `telemetry` key there is a genuine conflict. Worth a
> separate issue to alias them under `skein.*`; not part of this proposal, but the reason to get
> `events` right the first time.

## Packaging

Three tiers, mirroring telemetry:

1. **`@skein-js/events`** — pipeline, interface, vendor-neutral crypto helpers (constant-time
   compare, replay windows, signature-header parsing). These are the parts people get wrong; a naive
   `===` on a signature is a timing oracle.
2. **First-party sources** — `@skein-js/events-twilio` etc., **capped at three**. A fourth requires
   dropping one. "A few" without a number becomes twenty. Chosen to stress different seams:

   | Source          | What it proves                                                               |
   | --------------- | ---------------------------------------------------------------------------- |
   | Twilio WhatsApp | URL-based HMAC-SHA1, form encoding, expiring indicators, the motivating case |
   | Slack           | Raw-body signature, the `respond` escape hatch, bot-echo filtering, 3s ack   |
   | Webhook email   | Native `In-Reply-To` threading, weak-auth fallback, non-chat, **no signals** |

3. **Community sources** — own repos, `skein-source-*` convention. Adding a provider requires no
   skein release and no PR here, which is the real test of whether the interface is good.

**No vendor SDKs** — they are the actual liability (breaking changes, transitive deps, install
weight), and raw HTTP against the documented scheme is enough. A first-party source over ~100 lines
means the core is missing something; fix the core.

**The security posture change is real:** shipping a first-party source makes skein responsible for
the correctness of _someone else's_ signature scheme — a flaw there is a CVE in skein rather than in
user code. That is the argument for the cap, and for an adversarial **source conformance suite**
mirroring the `SkeinStore` one, so a community source can prove it rejects forged signatures, stale
timestamps, duplicate ids and bot echoes without hand review.

## Open questions

- **`threadKey` → thread id: verbatim or hashed?** Verbatim is debuggable in logs; hashing avoids a
  phone number in a primary key, which carries real GDPR weight. **Leaning hashed, raw key in thread
  metadata.**
- **Signal fan-out at scale.** Every active run with a subscribed source holds a bus subscription
  and, with `keepalive`, a timer. Thousands of concurrent conversations is a different load profile
  from thousands of API runs. Needs a bounded-subscription story before Slack ships.
- **Which stream mode satisfies which subscription** — `progress` could ride `updates` (cheap) or
  `events` (rich). Chosen by the pipeline, not the source; not yet pinned.
- **Chunked answer streaming**, deferred: send the answer in pieces, crash halfway, and the outbox
  replays a message the user already partly received. Needs provider-side message editing (Slack can,
  WhatsApp cannot) or a resumable delivery cursor. Slack's `chat.update` suggests the eventual design
  is provider-capability-dependent.
- **Attachments** — out of scope for v1, and the first thing anyone will ask for.

## Success criteria

1. A working Twilio WhatsApp integration — verify, dedup, thread mapping, HITL resume, typing
   indicator, durable reply — in **under 60 lines** of user code, written **entirely outside this
   repo**. _Phase 1 baseline: the same integration by hand is **334** code lines, so this is a target
   to be tested at stage 2, not a figure already banked._
2. A **GitHub webhook** integration on the identical interface, using no chat-specific concept and
   subscribing to no signals. The real test of the thesis; if it needs special-casing, the
   abstraction is message-shaped and wrong.
3. Zero vendor SDKs in skein's dependency tree.
4. Deleting the feature changes nothing for a user who never configured it.
5. The pipeline adds **no new `SkeinStore` resource** beyond the delivery outbox's.
6. An event route cannot create a run the deployment's `Auth` block would have denied — proven
   adversarially, including the forged-`x-auth-scheme` case.
7. Killing the process mid-run loses the typing indicator and **never** loses the answer.

## Phase 1 result — the example is built, and the kill condition did not fire

> **The kill condition, as it was stated up front.** "The honest baseline is shipping nothing beyond
> the delivery outbox… **If the phase-1 example comes out short without a pipeline, that alternative
> wins and we take it.**" It did not come out short — but the reason to proceed turned out to be
> different from the reason predicted. See the verdict below.

[`examples/whatsapp-typing`](https://github.com/skein-js/skein-js/tree/main/examples/whatsapp-typing)
exists: all seven steps against today's public API, no pipeline, 14 offline tests, verified end to
end against a live server including the async human-in-the-loop turn.

**The measurement.** Non-comment, non-blank lines in the four integration files, excluding the graph
(the user's product either way), the Twilio transport seam, the server bootstrap, and the tests:

| Step                                | File                  | Code lines |
| ----------------------------------- | --------------------- | ---------: |
| 1 · verify                          | `twilio-signature.ts` |         32 |
| 2 · dedup · 3 · thread · 4 · branch | `inbound-route.ts`    |        137 |
| 6 · progress                        | `typing-indicator.ts` |         87 |
| 5-out · 7 · deliver                 | `reply-route.ts`      |         78 |
| **Total**                           |                       |    **334** |

Against success criterion 1 — "under 60 lines of user code" — that is a **5.6× miss**, and the
criterion should be read as aspirational rather than achieved. Steps 3 and 7 really are close to
free, exactly as the genericity thesis predicted; the cost is concentrated in 1, 4 and 6.

**But line count is the weaker half of the finding.** Three things turned out to be not merely
tedious but _impossible or actively wrong_ in user code, and none of them were in this proposal:

1. **An `interrupted` thread has no server-side protection.** `interrupted` is a **terminal** run
   status ([`core/src/store/runs.ts:239`](https://github.com/skein-js/skein-js/blob/main/packages/core/src/store/runs.ts);
   the comment above `hasActiveRun` says so outright), so `createIfThreadIdle` sees an idle thread
   and a plain start on an interrupted thread **succeeds**, silently discarding the pending
   interrupt — no 422, no warning, no log line. `multitask_strategy` guards only `pending`/`running`
   and cannot help. An in-process mutex closes the `idle → busy` window; nothing closes
   `idle → interrupted` across replicas, because there is no `if_thread_status` on run create and
   the engine's own per-thread lock is internal. **This is the proposal's strongest justification and
   it was previously stated only as a default (`onExisting: "resume"`), not as a missing primitive.**
2. **`Idempotency-Key` fires on correct behaviour.** `requestFingerprint` hashes the request body. A
   provider retry that correctly re-reads the thread and derives a _resume_ instead of a _start_
   sends the same key with a different body and is refused `422 idempotency_key_reused`. The header
   assumes a client replaying a fixed request; a webhook derives its body from mutable server state.
   Splitting the key per branch is worse — then the retry really does create a second run. The only
   correct user-side handling is to catch 409 and 422 and answer the provider 2xx anyway.
3. **The interrupt question is unreachable from the callback.** `buildDeliveryPayload` sends
   `{...run, values, run_started_at, run_ended_at}`; the interrupt payload lives in the thread
   snapshot's `tasks[].interrupts` and is not part of `values`. Rendering the question therefore
   costs a second round trip to `threads.get`, and skipping it strands the conversation permanently
   with nothing reported anywhere.

**Four smaller findings, all fixable independently of the pipeline:**

- `equalsConstantTime` is not exported, so every source author hand-rolls a timing-safe compare —
  including the length guard, without which `timingSafeEqual` _throws_ and a forged short signature
  becomes a 500 instead of a 401. `verifySkeinSignature` does not transfer (it is skein's outbound
  format); only its shape does.
- **`embedInMemoryGraphs` sets no `webhooks`**, and `SKEIN_WEBHOOK_SECRET` is read only on the
  `{ config }` path — so an embedded host that follows the docs gets working but **unsigned**
  callbacks. A fail-open indistinguishable from a working setup. Worth fixing on its own.
- **`ProtocolRuntime` exposes no `deps`**, so the run event bus is unreachable on the `{ config }`
  path every CLI deployment takes. The example uses `runs.joinStream` instead, which costs an HTTP
  connection per in-flight conversation — the load question under Open questions is real, and the
  cheap path is available only to hosts that hand-built their deps.
- **The official SDK cannot express the request.** `RunsCreatePayload` has no `headers`, so the one
  header skein asks webhook callers to send cannot be set per request; `AsyncCaller` also retries and
  hides the status code the route must read. The example drops to raw `fetch` for run creation.

**Corrections to this proposal, from building it:**

- Twilio's typing indicator is keyed on the **inbound `MessageSid`**, so `idempotencyKey` and
  `replyTo` are the same value for the motivating provider, and it **auto-clears on delivery** —
  there is no "stop typing" call, which means `RunSignal`'s `settled` kind buys nothing here. Since
  `RunSignal` would be permanent public API, that is worth resolving before it ships.
- Phase 1 assumed the typing indicator would be "wired by hand off the existing run event bus". It
  cannot be, for the `deps` reason above. The phrasing should be `runs.joinStream`.

**Verdict: proceed, with the justification rewritten.** The case for the pipeline is _not_ the 334
lines — a determined user can write those once and copy them. It is that three of the seven steps
cannot be made correct from user code at all, and that the failures are silent: a discarded
interrupt, a retry refused for being right, a question never asked. Those are precisely the failures
the proposal predicted would "land in front of end users rather than in a test".

## What we need to build

Phase 1 changed the shape of this work. Three of its findings are **missing primitives, not a missing
pipeline** — each is a defect on its own terms, each is useful to someone who never adopts
`EventSource`, and each would otherwise get quietly absorbed into a big feature where nobody could
adopt it separately. Golden rule 1 says build the primitive, not the feature, so those come first.

Stage 0 is worth doing **even if the pipeline is never built**. That is the test each item had to
pass to be in it.

### Stage 0 — the missing primitives

| #   | What                                       | Why it is a defect today                                           | Blocks |
| --- | ------------------------------------------ | ------------------------------------------------------------------ | ------ |
| 0.1 | A thread-status precondition on run create | A start on an `interrupted` thread silently discards the interrupt | step 4 |
| 0.2 | Pending interrupts in the delivery payload | The question a run is waiting on is unreachable from the callback  | step 5 |
| 0.3 | Export the signature-verification helpers  | Every source author hand-rolls a timing-safe compare               | step 1 |
| 0.4 | Close the embed-path signing fail-open     | `embedInMemoryGraphs` yields silently **unsigned** callbacks       | step 7 |

**0.1 — a thread-status precondition on run create.** The load-bearing one. `interrupted` is a
terminal run status, so `createIfThreadIdle` sees an idle thread and no multitask strategy guards it.
The smallest primitive that fixes this is a **precondition**, not a policy:

```jsonc
// POST /threads/{id}/runs
{ "assistant_id": "support", "input": …, "if_thread_status": ["idle", "error"] }
// → 409 `thread_status_mismatch`, carrying the status actually observed
```

A precondition rather than the proposal's `onExisting` because **policy belongs to the deployment**:
"a message on an interrupted thread is an answer" is true for WhatsApp and false for a Stripe event.
`if_thread_status` lets the caller decide and makes the decision atomic; `onExisting` can then be
built on top of it inside the pipeline rather than being the only way to get correctness. It also
composes with `multitask_strategy` instead of overlapping it — that one guards `pending`/`running`,
this one guards everything else.

The check has to live **in the driver's atomic create**, alongside `createIfThreadIdle`'s existing
condition — not merely under the engine's `locks.run(threadId, …)`, which is in-process and would
leave the window open across replicas, exactly as the example's hand-written mutex does. That means
no new storage and no new transaction shape, but it does mean both drivers plus the `SkeinStore`
conformance suite.

**0.2 — pending interrupts in the delivery payload.** `buildDeliveryPayload` sends
`{...run, values, run_started_at, run_ended_at}`. Add the thread snapshot's pending interrupts, so a
receiver can render the question without a second round trip — and, more importantly, so that
"deliver the interrupt" is possible at all for a receiver that only has the callback:

```jsonc
{ "run_id": "…", "status": "interrupted", "values": { … }, "interrupts": [{ "value": … }] }
```

Additive, and only present on an `interrupted` run. Two things to settle: it must count toward
`maxPayloadBytes` like `values` does, and it is stored at finalize time, so it is a snapshot rather
than a live read — which is correct, since the body is stored and replayed verbatim.

**0.3 — export the verification helpers.** `equalsConstantTime` is the concrete miss: unexported, and
the length guard it carries is the difference between a 401 and a thrown 500 on a forged short
signature. Export it, and add a vendor-neutral signature-header parser only once the Slack and Twilio
recipes in stage 5 prove what shape it should have — one worked example is not enough to generalise
from. `verifySkeinSignature` itself stays as-is: it is skein's outbound format and does not transfer.

**0.4 — close the embed-path signing fail-open.** `embedInMemoryGraphs` (and the Postgres embedding)
set no `webhooks`, and `SKEIN_WEBHOOK_SECRET` is read only on the `{ config }` path. An embedded host
that follows the docs gets working, **unsigned** callbacks — indistinguishable from a correct setup.
Read the same env var on the embed path, or refuse to sign silently and say so at boot.

**Not ours, but log it:** `RunsCreatePayload` has no `headers`, so the official SDK cannot send
`Idempotency-Key` per request. Worth an upstream issue on `@langchain/langgraph-sdk`; until then the
documented answer is a per-request `Client` with `defaultHeaders`, or raw `fetch`.

**Deliberately not in stage 0: the `Idempotency-Key` body-fingerprint problem** (finding 2). A
webhook derives its request body from mutable server state, so a correct retry legitimately changes
the body and is refused. Every fix — a fingerprint-exempt mode, a key that covers only the key —
weakens a guard that exists to catch a real caller bug, and the pipeline can avoid the problem
entirely by claiming the key _before_ deciding the branch. Leave the header alone and solve it in
stage 2.

### Stage 1 — raw bodies across the transports

Unchanged from the original phase 2, and still a hard prerequisite: all six transports parse and
discard, and `ProtocolRequest` has no field to carry bytes. Cheapest retention points are Fastify's
content-type parser and the Fetch adapter's reader, which already hold the string; Express needs
`express.json({ verify })` and Next.js Pages needs `bodyParser: false`. Phase 1 also surfaced that
**mount order is a silent trap** — a raw-body route registered after `skeinRouter` cannot verify a
signature — which is worth documenting regardless of whether this stage lands.

### Stage 2 — the pipeline and `EventSource`

As originally designed, with three corrections from phase 1:

- `onExisting` is implemented **on top of 0.1**, not instead of it.
- The pipeline claims the idempotency key **before** resolving the branch, which is what makes
  finding 2 disappear rather than needing an escape hatch in the header.
- Rendering an interrupt reads 0.2 from the outcome it already has, instead of a second `threads.get`.

Port `examples/whatsapp-typing` onto it and re-measure against the 334-line baseline. Success
criterion 1 ("under 60 lines") should be treated as a target to test, not a claim already banked.

### Stage 3 — run signals

Unchanged, with two corrections. `ProtocolRuntime` exposes no `deps`, so the projection has to be
reachable without hand-built deps or every CLI deployment pays an HTTP connection per conversation —
resolve that before the interface is advertised. And `RunSignal`'s `settled` kind buys nothing on the
motivating provider, since Twilio's indicator auto-clears on delivery; since the union is permanent
public API, justify each kind against a real consumer or drop it.

### Stage 4 — a second, non-chat source, plus the conformance suite

Unchanged: GitHub, before the interface is advertised as stable, while the contract is cheap to
change. The adversarial source-conformance suite lands here.

### Stage 5 — Slack and email, and the community-adapter story

Unchanged.

### What this order buys

Stage 0 is four small, separately reviewable changes that make the _hand-written_ integration
correct — which is the honest baseline this proposal is measured against, and the one most users will
still be on. If stages 2–5 never happen, skein is strictly better for inbound work than it is today,
and nobody is holding an `EventSource` they cannot withdraw.

</details>
