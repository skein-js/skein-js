# Proposal — Durable outbound delivery

> **Status:** Planned · **Depends on:** nothing · **Unblocks:**
> [inbound-events.md](./inbound-events.md)
>
> A design proposal, not shipped behaviour. See [proposals/README.md](./README.md).
>
> Idempotent run creation was Part 1 of this proposal and **shipped in 0.14** — it is documented in
> [agent-protocol.md](../agent-protocol.md#idempotent-run-creation-idempotency-key) and
> [langgraph-cli-compat.md](../langgraph-cli-compat.md#idempotency-skeinidempotency), and the design
> notes for it are gone from this file. What follows is the outbound half.

## Problem

A run is durable; the news that it finished is not. The webhook dispatcher is a bare `fetch` and its
failures are logged and swallowed **by design**, so a slow receiver can't stall a thread or fail a
run. The consequence: if the receiver is redeploying for ten seconds, that notification is gone
forever and the run still reports `success`. Nothing records that it was lost. And because the POST
is unsigned, a receiver cannot tell a real callback from anyone who guessed the URL.

The durable execution guarantees that make skein worth running stop at the process boundary.

## Goals

- **G1 — A completion notification survives a transient receiver outage.** Receiver down for a
  minute, notification still arrives.
- **G2 — A receiver can authenticate a callback** as genuinely from this instance, and reject
  replays, without a shared transport (no mTLS, no VPC assumptions).
- **G3 — Delivery is observable and recoverable.** See attempts, see what failed and why, replay by
  hand.
- **G4 — Works on every driver combination**, including `skein dev` with no Docker.

**Non-goals.** Exactly-once delivery (this is at-least-once plus a stable dedup key, and the docs
must say so loudly). Changing the `webhook` payload shape — LangGraph parity on the body stays, only
the delivery semantics change underneath. Ordering across distinct runs. A general-purpose message
bus.

There is no prior art to copy: `webhook` is a bare URL string in the LangGraph SDK, with no signing
secret, retry policy, delivery record or replay endpoint. Where the wider ecosystem has a convention
(Stripe's `t=…,v1=…` signature) adopt it verbatim so receivers can reuse verification code.

## Design

**Storage.** A `deliveries` resource on `SkeinStore`: id, run id, target URL, payload, status
(`pending` / `delivering` / `delivered` / `dead`), attempt count, `next_attempt_at`, last error.

**The one thing that makes it durable:** enqueue the delivery **in the same transaction that writes
the run's terminal status**. Without that, a crash between "run succeeded" and "delivery enqueued"
loses the notification and we have rebuilt today's bug with more code.

**That mechanism does not exist yet, and it is the largest item here.** `#withTransaction` is private
to `PostgresSkeinStore` and `SkeinStore` exposes no transaction seam; its only cross-repo atomic
operation is `CronRepo.claimAndCreateRun`, hardcoded to (cron, run). So this begins with a **new
combined driver method on `RunRepo`** — shaped like `claimAndCreateRun`, conditional on the run not
already being terminal, writing status and delivery together, implemented in both drivers and pinned
by the conformance suite. Two consequences that are easy to miss:

- `finalizeRun` is a read-check-write. Its terminal guard has to move _into_ the new method, or the
  delivery insert races a concurrent cancel.
- The cancel paths (`cancelActiveRun`, `cancelRun`) must move in the **same commit**. Today the
  engine fires a webhook even when it loses to a cancel; with a strictly-conditional insert that
  delivery has to come from the winner, and between the two changes there is a window where a cancel
  that beats the engine notifies nobody.

A generic `withTransaction` on `SkeinStore` was considered and rejected — a heavy contract to ask
every driver (including third-party) to honour, and hard to specify identically across memory and
Postgres.

**A delivery worker drains it** with exponential backoff and jitter, a capped attempt count, then
`dead`. It runs wherever the run worker runs; no new process.

**Signing.** Stripe's format, so receivers can reuse existing verification code:

```
X-Skein-Signature: t=1754300000,v1=<hex hmac-sha256 of "{t}.{raw body}">
X-Skein-Delivery-Id: <stable across every retry — the receiver's dedup key>
X-Skein-Attempt: 3
```

`X-Skein-Delivery-Id` is the load-bearing one: it is how a receiver makes our at-least-once safe on
their side, and it must be impossible to miss in the docs. A receiver that is itself a skein instance
can feed it straight into its own `Idempotency-Key` — on the background and wait creates, though not
the streaming ones, which reject that header with a 422.

**Admin surface.** `GET /webhook-deliveries` (filter by run, status) and
`POST /webhook-deliveries/{id}/replay`, behind the same auth as everything else and filterable out by
the existing `http.disable_*` mechanism.

**Compatibility.** The existing `webhook` field keeps working and keeps its payload; the legacy
fire-once path stays available via config.

## Configuration

Under the **`skein.*` namespace** in `langgraph.json` — `skein.idempotency` already shipped in
exactly this shape, so it is a worked precedent rather than a plan. Keys are `snake_case`, matching
every other block. Omitting the block preserves today's semantics.

```jsonc
{
  "skein": {
    "webhooks": {
      "secret": "dev-only-literal", // also accepts an array during rotation
      "secrets": { "path": "./src/webhook-secrets.ts:secrets" }, // mutually exclusive with `secret`
      "retries": { "max_attempts": 12, "initial_delay_ms": 1000, "max_delay_ms": 3600000 },
      "allowed_hosts": ["hooks.example.com"],
    },
  },
}
```

**`"${SKEIN_WEBHOOK_SECRET}"` will not work.** skein does not expand `${VAR}` inside
`langgraph.json` — `resolve-env.ts` only reads the `env` block into `process.env` — so writing it
that way yields the literal 25-character string as the signing key, which is the worst possible
failure mode for one. Resolution without a new expander: precedence is `secrets.path` → literal
`secret` → `SKEIN_WEBHOOK_SECRET` (comma-separated for rotation), resolved in `@skein-js/server-kit`
next to `ttl-config.ts`. A literal `secret` warns once at startup, because a secret in
`langgraph.json` is a secret committed to the repository. (Related: the comment in
`packages/config/src/langgraph-json.ts` claiming the loader "supports env substitution" is inaccurate
and should be fixed in the same change.)

**Retry defaults must be quoted as a sum, not as knobs.** `max_attempts: 8` at
`initial_delay_ms: 1000` is 1+2+4+…+64 ≈ **127 seconds** of horizon — it clears a 60-second outage
with ~2× margin and nothing else, and makes `max_delay_ms` unreachable. Hence 12 (≈68 minutes). An
operator cannot evaluate "8 attempts" without doing that arithmetic themselves.

**Per-target secrets, not one static secret.** If every receiver verifies against the same key, any
receiver holding it can forge a callback that any _other_ receiver accepts as genuine — a
multi-tenant correctness bug, not an operational inconvenience. So the secret is a function of the
delivery. `secrets.path` follows [`loadAuthEngine`](https://github.com/skein-js/skein-js/blob/main/packages/config/src/auth-engine.ts)
point for point — same `{ path }` shape, same `parseGraphSpec`, same injectable `importModule` seam,
same distinct `SkeinConfigError` per failure, same lazy import — and like `auth`, the user-facing
type differs from the internal one:

```ts
/** What a user exports from their module. An object with a method, not a bare function: validatable,
    and able to grow a second method later without a breaking signature change. */
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

Returning an **array** keeps rotation working: sign with the first, and document that receivers
should accept any listed value — otherwise rotating a key silently drops deliveries until every
receiver has caught up. **The resolver owns its own caching**: it will usually front a secret manager,
and a cache inside skein would mean skein owning invalidation semantics it cannot get right. skein
calls `resolve` per delivery; the implementation memoizes. Document that loudly — the failure is a
latency and cost problem rather than a visible one.

`allowed_hosts` should get the same treatment (a predicate is strictly more expressive than a list,
and per-tenant allowlists are the same argument), on the same loaded object rather than a second
`path`, and in the same change rather than as a second breaking one.

## Risks

- **Payload storage growth, and why the obvious fix is unavailable.** Re-rendering the payload from a
  run reference at send time is not a semantic trade-off, it is **unimplementable** for the case that
  matters most: `deleteThreadIfRunOwnedIt` removes a stateless run's server-created thread right
  after delivery, and in Postgres that cascades the run row away — so a retry an hour later has
  neither a run row nor a checkpoint to render from. Stateless `POST /runs` is exactly the "external
  service drives skein and gets the answer back" case this exists for, so re-rendering would make the
  flagship path the one that cannot retry.

  Therefore: store the payload, capped at `max_payload_bytes` (default 256 KiB) with `values`
  replaced by a truncation marker _inside_ the signed body so a receiver cannot be misled about it;
  clear it on `markDelivered`, making steady-state storage (in-flight × cap) rather than (all
  deliveries ever × cap); sweep terminal rows on a `retain_until`, keeping `dead` payloads so replay
  can actually resend. Worst case is then `max_attempts × concurrent_runs × max_payload_bytes` and
  belongs in the docs.

- **SSRF gets sharper.** With aggressive retries an attacker-supplied `webhook` URL becomes a better
  amplifier. The allowlist should probably become the default posture rather than an opt-in.
- **Rotation health is unresolved.** Whether skein should surface a signal for "deliveries still
  verifying against an outgoing key" — without one there is no way to know when a rotation is safe to
  complete.
- **Retrying into a non-idempotent receiver** turns our reliability improvement into their duplicate
  bug. `X-Skein-Delivery-Id` is the answer, and only works if the docs make it unmissable.

## Success criteria

1. An integration test kills the receiver for 60 seconds mid-suite; **every** notification still
   arrives, none marked `dead`.
2. A receiver can reject a forged callback and a replayed callback using only the documented headers
   and the shared secret — demonstrated in an example, not just described.
3. Both pass on `storage-memory` + in-memory queue with no Docker, and on Postgres + Redis.

## Phasing

1. **Delivery outbox + worker + retries** — the durability core, starting with the combined
   `RunRepo` method above.
2. **Signing + delivery headers** — the receiver-side story.
3. **Admin/replay endpoints + docs** — operability.

Step 1 is what [inbound-events.md](./inbound-events.md) depends on.
