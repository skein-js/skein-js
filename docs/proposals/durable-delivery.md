# Proposal — Durable delivery: idempotent runs, reliable callbacks

> **Status:** Planned — closes an existing gap, so the open questions are about _how_, not _whether_
> · **Depends on:** nothing · **Unblocks:** [inbound-events.md](./inbound-events.md)
>
> A design proposal, not shipped behaviour. See [proposals/README.md](./README.md).

## Contents

- [Problem](#problem)
- [What we hope to achieve](#what-we-hope-to-achieve)
- [Non-goals](#non-goals)
- [Prior art — what LangGraph does here](#prior-art--what-langgraph-does-here)
- [Design](#design)
  - [Part 1 — Idempotent run creation](#part-1--idempotent-run-creation)
  - [Part 2 — Durable outbound delivery](#part-2--durable-outbound-delivery)
- [Configuration](#configuration)
  - [A resolved secret, not a static one](#a-resolved-secret-not-a-static-one)
- [Alternatives considered](#alternatives-considered)
- [Risks and open questions](#risks-and-open-questions)
- [Success criteria](#success-criteria)
- [Phasing](#phasing)

## Problem

skein can be **driven** by another service today — `POST /threads/{id}/runs` starts a durable
background run, and a `webhook` URL is POSTed the settled run. What it cannot do is hold up its end
of that conversation reliably. There are two holes, one at each end of the round trip.

**Inbound: nothing is idempotent.** Every webhook provider retries — Twilio on timeout or 5xx,
Stripe, GitHub, Slack, SendGrid, all of them. A retried request creates a _second run_, which means
a second reply to the end user, or two agents independently acting on the same event. Today the only
defence is a dedup table in the caller's own application, re-implemented per integration, and it has
to be written correctly the first time because the failure is silent and user-visible.

**Outbound: the callback is fire-once and best-effort.** The default dispatcher is a bare `fetch`
(`packages/agent-protocol/src/deps.ts:233`) and its failures are logged and swallowed **by design**
(`packages/agent-protocol/src/runs/run-execution.ts:120-133` — deliberate, so a slow receiver can't
stall a thread or fail a run). The consequence: if the receiver is redeploying for ten seconds, that
notification is gone forever and the run still reports `success`. Nothing records that it was lost.
And because the POST is unsigned, a receiver cannot tell a real callback from anyone on the internet
who guessed the URL.

Put together: the durable execution guarantees that make skein worth running **stop at the process
boundary**. A run is durable; the news that it finished is not.

## What we hope to achieve

- **G1 — A retried inbound request never produces a duplicate run.** Same key, same run, same
  response body.
- **G2 — A completion notification survives a transient receiver outage.** Receiver down for a
  minute, notification still arrives.
- **G3 — A receiver can authenticate a callback** as genuinely from this skein instance, and reject
  replays, without a shared transport (no mTLS, no VPC assumptions).
- **G4 — Delivery is observable and recoverable.** You can see attempts, see what failed and why,
  and replay by hand.
- **G5 — Works on every driver combination**, including `skein dev` with no Docker. The crons work
  set this precedent and it should hold here.

The strategic goal behind those: make **"an external service can drive a skein agent and reliably
get the answer back"** a property of the server, not a thing every user rebuilds. That is the
foundation [inbound-events.md](./inbound-events.md) is built on, and it is worth shipping on its own
even if that proposal never happens.

## Non-goals

- **Exactly-once delivery.** We are building at-least-once plus a stable dedup key the receiver can
  use. Anyone claiming exactly-once over HTTP is selling something. This must be stated loudly in
  the user docs, not buried.
- **Changing the `webhook` payload shape.** LangGraph parity on the body stays; only the _delivery
  semantics_ change underneath it.
- **A general-purpose message bus or pub/sub product.** This is run-completion notification, scoped
  to that.
- **Ordering guarantees across distinct runs.** Per-thread ordering is the run queue's job and
  already exists; deliveries are independent.
- **Idempotency for reads or for non-mutating routes.** Only creates.

## Prior art — what LangGraph does here

Neither exists. Diffing `@langchain/langgraph-sdk` v1.9.25:

- **Idempotency** — zero hits for `idempot`/`Idempotency` in the client surface. Not in Platform,
  not in the OSS `@langchain/langgraph-api`.
- **Delivery semantics** — `webhook` is a bare URL string (`dist/types.d.ts`), with no signing
  secret, no retry policy, no delivery record, and no replay endpoint anywhere in the SDK.

So unlike most of the roadmap, this is **not parity work**. There is no wire shape to copy and no
compatibility constraint — but also no precedent, so the design is ours to get right, and ours to
get wrong. Where a convention exists in the wider ecosystem (Stripe's `Idempotency-Key`, Stripe's
`t=…,v1=…` signature format) we should adopt it verbatim rather than invent, so receivers can reuse
verification code they already have.

## Design

### Part 1 — Idempotent run creation

**Surface.** An `Idempotency-Key` request header on the mutating creates: `POST /threads/{id}/runs`
(all three run modes), `POST /runs`, `POST /runs/batch`, and `POST /threads`. Absent header = today's
behaviour exactly, so this is purely additive.

**Storage.** A new `SkeinStore` resource — keyed on `(key, scope)`, storing a request fingerprint,
the original response status and body, the resulting `run_id`, and an expiry.

**The claim must be atomic.** Insert-first and let the uniqueness constraint arbitrate, exactly the
way `RunRepo.createIfThreadIdle` and the cron compare-and-swap claim already work in this codebase.
A read-then-write check has a window, and the window is precisely the double-delivery burst we are
defending against — two Twilio retries land on two instances within milliseconds.

**Replay semantics.**

| Case                                                 | Response                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| Key unseen                                           | Execute normally; record the response                                 |
| Key seen, same fingerprint, original done            | Replay the recorded response verbatim, plus `Idempotent-Replay: true` |
| Key seen, same fingerprint, original still in flight | `409` — retry later (do not block holding a connection)               |
| Key seen, **different** fingerprint                  | `422` — same key, different body is a caller bug worth surfacing      |

The `Content-Location` header must be replayed too — it is what makes the SDK's `onRunCreated` and
`useStream`'s `reconnectOnMount` work, and a replay that drops it silently breaks reconnect.

**Expiry.** Default 24h, swept by the same mechanism as store item TTL. Long enough to cover any
provider's retry schedule, short enough that the table doesn't grow without bound.

### Part 2 — Durable outbound delivery

**Storage.** A `deliveries` resource on `SkeinStore`: id, run id, target URL, payload, status
(`pending` / `delivering` / `delivered` / `dead`), attempt count, `next_attempt_at`, last error.

**The one thing that makes it durable:** enqueue the delivery **in the same transaction that writes
the run's terminal status**. That is the transactional-outbox pattern already built for crons —
`docs/roadmap.md` describes the cron claim and run row committing together, which "lifts cron _and_
ordinary background runs to at-least-once delivery." The same mechanism, pointed at notifications.
Without this, a crash between "run succeeded" and "delivery enqueued" loses the notification and we
have rebuilt today's bug with more code.

**A delivery worker drains it** with exponential backoff and jitter, a capped attempt count, then
`dead`. It runs wherever the run worker runs; no new process.

**Signing.** Stripe's format, deliberately, so receivers can reuse existing verification code:

```
X-Skein-Signature: t=1754300000,v1=<hex hmac-sha256 of "{t}.{raw body}">
X-Skein-Delivery-Id: <stable across every retry — the receiver's dedup key>
X-Skein-Attempt: 3
```

`X-Skein-Delivery-Id` is the load-bearing one. It is how a receiver makes _our_ at-least-once safe
on _their_ side, and it closes the loop with Part 1: a receiver that is itself a skein instance can
feed our delivery id straight into its own `Idempotency-Key`.

**Admin surface.** `GET /webhook-deliveries` (filter by run, status) and
`POST /webhook-deliveries/{id}/replay`. Behind the same auth as everything else, and filterable out
of the route table by the existing `http.disable_*` mechanism.

**Compatibility.** The existing `webhook` field keeps working and keeps its payload. Behaviour
upgrades underneath it; the legacy fire-once path stays available via config for anyone who wants
it.

## Configuration

Under the **`skein.*` namespace** in `langgraph.json` — not a top-level key, and not a separate
`skein.json`. skein already reserves `skein` for its own settings
([`langgraph-json.ts`](../../packages/config/src/langgraph-json.ts)), and putting a skein-original
surface at the top level is a forward-collision risk if LangGraph later claims the same name. See
[inbound-events.md](./inbound-events.md#configuration--skeinevents-not-a-new-file) for the full
reasoning, which applies identically here.

Off-by-default in the sense that omitting it preserves today's semantics:

```jsonc
{
  "skein": {
    "webhooks": {
      "secret": "${SKEIN_WEBHOOK_SECRET}", // literal; also accepts an array during rotation
      "retries": { "max_attempts": 8, "initial_delay_ms": 1000, "max_delay_ms": 3600000 },
      "allowed_hosts": ["hooks.example.com"], // SSRF guard; see Risks
    },
  },
}
```

Keys are `snake_case`, matching every other block in `langgraph.json` (`default_ttl`,
`disable_studio_auth`, `dockerfile_lines`) rather than the camelCase this proposal used in revision 1.

Also available in code through the existing `ProtocolDeps` seam, matching how telemetry and
`webhookDispatcher` already work.

### A resolved secret, not a static one

A single literal secret is the simple case, and it is the wrong one more often than it looks.

**A static secret is a multi-tenant correctness bug, not just an operational inconvenience.** If
every receiver verifies against the same key, then any receiver holding that key can forge a callback
that _any other_ receiver will accept as genuine. In a deployment where each tenant registers their
own `webhook` URL, per-target secrets are the only way signing means anything. That, not rotation
convenience, is the argument for making the secret a function of the delivery.

**This follows the `auth` block's pattern exactly** — same config shape, same loader, same validation
discipline, same user-facing-vs-internal split. Not a new mechanism:

```jsonc
{
  "skein": {
    "webhooks": {
      // Simple case: a literal, or an array during rotation.
      "secret": "${SKEIN_WEBHOOK_SECRET}",

      // Complex case: mutually exclusive with `secret`. Mirrors `auth: { path }`.
      "secrets": { "path": "./src/webhook-secrets.ts:secrets" },
    },
  },
}
```

Point-for-point with [`loadAuthEngine`](../../packages/config/src/auth-engine.ts), which is the
reference implementation to copy rather than paraphrase:

| `auth`                                                     | `webhooks.secrets`                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| Block is an object with a `path` key                       | Same — `{ path }`, not a bare scalar                       |
| `parseGraphSpec(auth.path, configDir)` — the shared parser | Same call; **no second spec parser**                       |
| Injectable `importModule` seam so tests skip real imports  | Same seam                                                  |
| Distinct `SkeinConfigError` per failure                    | Same three: import failed, export missing, bad shape       |
| Validates `isAuthInstance(exported)` before use            | Validates the exported object's shape before use           |
| Heavy deps imported lazily, only when configured           | Same                                                       |
| User writes an `Auth`; internals consume an `AuthEngine`   | User writes `WebhookSecrets`; internals consume a resolver |

That last row is the part I had wrong. Auth's user-facing type and its internal injectable type are
**deliberately different** — `loadAuthEngine` adapts an `Auth` instance into the `AuthEngine` the rest
of the system depends on. Applying the same split here:

```ts
/** What a user exports from their module — the public, config-loaded contract. */
export interface WebhookSecrets {
  resolve(target: DeliveryTarget): Promise<string | readonly string[]>;
}

export interface DeliveryTarget {
  url: string;
  runId: string;
  threadId: string;
  principal?: AuthUser;
}
```

**An object with a method, not a bare function**, for the same reason `Auth` is an instance rather
than a callback: it is validatable (`typeof exported.resolve === "function"` gives a precise
`SkeinConfigError` instead of a `TypeError` at first delivery), and it can grow a second method later
without a breaking signature change — which matters given how hard this is to change once third
parties depend on it. The one thing auth gets that duck-typing does not is a **branded identity**, so
its error can say _"not an `Auth` instance from `@langchain/langgraph-sdk/auth`"_. If that precision is
wanted here, `WebhookSecrets` becomes a small class exported from `@skein-js/core`; the tradeoff is
ceremony for a single-method interface. **Open, leaning duck-typed.**

Returning an **array** from `resolve` keeps rotation working: sign with the first, and document that
receivers should accept any listed value — otherwise rotating a key means silently dropping
deliveries until every receiver has caught up.

**The resolver owns its own caching.** It will usually front a secret manager, and calling Vault or
AWS Secrets Manager once per delivery attempt is a bad default — but a cache inside skein means skein
owns invalidation semantics it has no way to get right. Simpler contract: skein calls `resolve` per
delivery, and the implementation memoizes. Documented loudly, because the failure is a latency and
cost problem rather than a visible one.

The same generalization applies to `allowed_hosts` (a predicate is strictly more expressive than a
list, and per-tenant allowlists are the same multi-tenant argument) — worth doing at the same time
rather than as a second breaking change, and it belongs on the same loaded object rather than as a
second `path`.

**Note the asymmetry with inbound sources.** [inbound-events.md](./inbound-events.md) needs no
equivalent seam: an `EventSource` is already user code loaded by `path:export`, so it resolves its
own Twilio auth token or Slack signing secret however it likes. Outbound needs a resolver precisely
_because_ its configuration is declarative.

## Alternatives considered

**Do nothing; document the pattern.** Tell users to make their receiver tolerate loss, and to build
their own dedup. This is the status quo and the honest baseline. Rejected because the failure mode is
silent, user-visible, and re-encountered by literally every integration — it is exactly the class of
plumbing skein exists to absorb.

**Push it into the queue driver (Redis) instead of the store.** Tempting — the retry machinery is
queue-shaped. Rejected because it would make durable delivery a Redis-only feature, breaking G5 and
diverging `skein dev` from production. The crons work already established that this kind of state
belongs in `SkeinStore` so it survives a Redis flush and stays searchable.

**Adopt an existing outbox/webhook library.** Worth a real look during implementation, per the
reuse-first golden rule — but the outbox has to commit inside _our_ store transaction, which means
it has to speak our driver abstraction. A library that owns its own Postgres connection can't give
us the atomicity that is the entire point.

**Signature format of our own design.** Rejected. Stripe's `t=…,v1=…` is widely implemented and
already understood; inventing a variant costs every receiver a bespoke verifier for no gain.

## Risks and open questions

- **Payload storage growth.** A settled run's state can be large, and we would be storing a copy per
  delivery. Options: store a run reference and re-render at send time (cheaper, but the payload then
  reflects state at send rather than at completion — a semantic change), or cap and truncate. **Open.**
- **SSRF gets sharper.** The existing docs already suggest an allowlist when accepting untrusted
  `webhook` URLs; with aggressive retries, an attacker-supplied URL becomes a more effective
  amplifier. The allowlist should probably become the default posture rather than an opt-in.
- **Secret rotation** — largely answered by
  [the resolver](#a-resolved-secret-not-a-static-one): an array of secrets, signed with the first,
  and receivers accept any. What remains open is whether skein should surface a rotation _health_
  signal (deliveries still verifying against an outgoing key), since without one there is no way to
  know when a rotation is safe to complete.
- **Retrying into a non-idempotent receiver** turns our reliability improvement into their duplicate
  bug. `X-Skein-Delivery-Id` is the answer, and it needs to be impossible to miss in the docs.
- **Does `Idempotency-Key` belong on `POST /threads` at all**, given issue #7 adds `if_exists`?
  Arguably `if_exists: "do_nothing"` already makes thread creation idempotent by construction, and
  adding both is two mechanisms for one job. **Open — lean toward runs-only.**

## Success criteria

Concrete, testable, and the acceptance bar for the work:

1. An integration test kills the receiver for 60 seconds mid-suite; **every** notification still
   arrives, in order of eventual delivery, none marked `dead`.
2. Replaying an identical run-create POST 50 times concurrently across two instances yields
   **exactly one** run and 50 identical responses.
3. A receiver can reject a forged callback and a replayed callback using only the documented
   headers and the shared secret — demonstrated in the example, not just described.
4. Every scenario above passes on `storage-memory` + in-memory queue with no Docker, and on
   Postgres + Redis.
5. A new row in the [roadmap](../roadmap.md) comparison table that LangGraph Platform cannot match.

## Phasing

1. **Idempotent run creation** — store resource, atomic claim, replay, conformance tests. Independently
   shippable and independently valuable.
2. **Delivery outbox + worker + retries** — the durability core.
3. **Signing + delivery headers** — the receiver-side story.
4. **Admin/replay endpoints + docs** — operability.

Steps 1 and 2 are the ones [inbound-events.md](./inbound-events.md) depends on.
