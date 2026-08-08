# Proposal — Inbound events: agents behind WhatsApp, Slack, and anything else

> **Status:** Planned · **Depends on:** [durable-delivery.md](./durable-delivery.md)
>
> A design proposal, not shipped behaviour. See [proposals/README.md](./README.md).

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

| Step                                    | Provider-specific?                                        |
| --------------------------------------- | --------------------------------------------------------- |
| 1. Verify the request is authentic      | The **recipe** varies; the primitives don't               |
| 2. Deduplicate the provider's retries   | No — only _where_ the event id lives varies               |
| 3. Resolve a stable key to a thread     | No                                                        |
| 4. Start / resume / enqueue / ignore    | No — policy, and it's the same policy everywhere          |
| 5. Map payload ↔ graph input and output | **Yes. This is the integration.**                         |
| 6. Signal progress while the run works  | No — a projection of the existing run event bus           |
| 7. Deliver the reply, durably           | No — [durable-delivery.md](./durable-delivery.md) owns it |

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
its own, that is a signal durable-delivery is incomplete and the gap belongs there, not here.

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
  └→ deliver(outcome, replyTo)  → durable, retried, recorded     [durable-delivery]
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
   repo**.
2. A **GitHub webhook** integration on the identical interface, using no chat-specific concept and
   subscribing to no signals. The real test of the thesis; if it needs special-casing, the
   abstraction is message-shaped and wrong.
3. Zero vendor SDKs in skein's dependency tree.
4. Deleting the feature changes nothing for a user who never configured it.
5. The pipeline adds **no new `SkeinStore` resource** beyond durable-delivery's.
6. An event route cannot create a run the deployment's `Auth` block would have denied — proven
   adversarially, including the forged-`x-auth-scheme` case.
7. Killing the process mid-run loses the typing indicator and **never** loses the answer.

## Phasing

1. **Write `examples/whatsapp-typing` first, against the raw primitives, with no pipeline at all** —
   including the typing indicator, wired by hand off the existing run event bus. Deliberate: it
   discovers the real contract instead of guessing.
2. **Raw-body preservation across all five transport adapters** — independently useful, and a hard
   prerequisite for any signature verification.
3. **Extract the pipeline**, the `EventSource` interface and the agnostic verification helpers from
   what phase 1 proved repetitive. Port the example onto it and measure the delta honestly.
4. **Run signals** — the `RunEventBus` projection, the subscription declaration, the keepalive timer,
   with the bounded-subscription question answered.
5. **A second, non-chat source** (GitHub) plus the conformance suite, before the interface is
   advertised as stable — while the contract is still cheap to change.
6. **Slack and email sources**; document the interface and the community-adapter story.

> **The kill condition, stated up front.** The honest baseline is shipping nothing beyond
> durable-delivery: users write ingress in their own app, and often already have one since skein
> mounts into Express/Fastify/Nest/Next. That alternative gives every integration correctness with
> zero new concepts and zero maintenance — it just doesn't give anyone step 4, progress signalling,
> or any guarantee that dedup and thread-keying were done right. **If the phase-1 example comes out
> short without a pipeline, that alternative wins and we take it.** Phase 3 measures the delta
> honestly, and if it isn't dramatic, ship only the helpers and stop.
