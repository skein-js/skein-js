# Production

Locking it down, being told when work finishes, and running it durably.

## Custom auth

The server is open by default. skein implements
[LangGraph's custom-auth model](https://docs.langchain.com/langsmith/custom-auth), so an existing `Auth`
file is drop-in.

```ts
// auth.ts
import { Auth, HTTPException } from "@langchain/langgraph-sdk/auth";

export const auth = new Auth()
  .authenticate(async (request) => {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    const user = token ? await verify(token) : undefined;
    if (!user) throw new HTTPException(401, { message: "Unauthorized" });
    return { identity: user.id, permissions: user.scopes };
  })
  .on("threads", ({ user }) => ({ owner: user.identity })); // scopes threads and their runs
```

Wire it with `"auth": { "path": "./auth.ts:auth" }` in `langgraph.json`, or in code as
`embedInMemoryGraphs(graphs, { auth })` — note the second argument **is** the overrides bag here, while
`embedPostgresGraphs` nests them under `overrides`. A returned filter both hides other owners' rows
and stamps ownership onto new ones.

**Inside a graph**, the principal arrives on the run config as
`config.configurable.langgraph_auth_user`, `…_user_id` and `…_permissions` — server-owned and
unspoofable, present only when auth is configured.

> [!WARNING]
> **The store is not scoped by an ownership filter**
>
> A store item carries no metadata to filter on, so **an authenticated caller can read every tenant's
> items** unless an `@auth.on.store` handler narrows it. Scope it by rewriting `value.namespace` — the
> pattern and its traps are in [agent-protocol.md](../agent-protocol.md#scoping-the-store).

Full route → permission map:
[agent-protocol.md](../agent-protocol.md#authentication--authorization).

## Get notified when a run finishes

Pass a `webhook` URL on run creation; skein POSTs the settled run to it.

```ts
await client.runs.create(threadId, "agent", { input, webhook: "https://example.com/hooks/run" });
```

**The callback is recorded in the same transaction as the run's terminal status**, so a crash between
"the run finished" and "someone was told" cannot lose it. That is the guarantee, and it comes from the
store — not from the retry policy, and not from anything you configure. skein attempts the first
delivery inline, so a healthy receiver hears within milliseconds; a failure is recorded and retried.

**It is at-least-once, not exactly-once.** A retry can duplicate a callback your receiver already
processed — after a network timeout that actually succeeded, say. Every attempt carries the same
`X-Skein-Delivery-Id`; dedupe on it. The API remains the source of truth for run state.

Each POST is aborted after `SKEIN_WEBHOOK_TIMEOUT_MS` (default 5s), sized against the 8s shutdown
budget so a slow receiver can't get you killed mid-POST. Delivery happens after the thread's execution
lock is released, so a slow target never blocks other runs on that thread — which also means two
callbacks for one thread are not guaranteed to arrive in run order.

### Retries are BullMQ's when you run Redis

Where the retry schedule lives depends on the queue driver, and this is the one place it matters:

|                        | Retry schedule                                                               | Survives a restart?                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Postgres + Redis**   | BullMQ — delayed jobs, exponential backoff with jitter, stalled-job recovery | **Yes.** A retry still waiting is in Redis                                                                              |
| **Postgres, no Redis** | skein polls the outbox for rows that are due                                 | No. A retry still waiting is lost on exit; the _delivery_ is not — the row is still there and the next boot picks it up |
| **Memory (dev)**       | Same poll, in-process                                                        | No, and neither is the delivery — nothing here is durable                                                               |

So: **run Redis in production.** skein warns at startup when your store is durable but your delivery
schedule is not. Want to exercise the real thing locally? `skein dev --queue redis` — the same BullMQ
path, against a local Redis.

There is one window neither side can close on its own: a Redis `add()` cannot join a Postgres
transaction, so a process that dies between committing the delivery and enqueueing its job leaves a
callback with no schedule. Nothing is lost — the row is committed — and a background sweep re-schedules
it, idempotently, on its next pass. That is the standard outbox trade: the database is the single
commit point, and the queue is a schedule rather than a second source of truth.

Tune the policy under [`skein.webhooks`](../langgraph-cli-compat.md#webhooks-skeinwebhooks). The
default is 12 attempts over roughly 34 minutes, which rides out a rolling deploy with room to spare.
Read that as a **time horizon, not a count**: dropping to 6 attempts is ~31 seconds, which does not
survive one redeploy.

A server accepting untrusted clients should set `skein.webhooks.allowed_hosts`: `webhook` is a
caller-supplied URL, so it is a server-side request to a target they chose, and retrying it turns a
one-shot SSRF probe into a repeated one. It is off by default so upgrading cannot start dropping your
own callbacks.

### Verify that a callback is really from you

Set `SKEIN_WEBHOOK_SECRET` and every callback carries `X-Skein-Signature` in Stripe's format —
`t=<unix seconds>,v1=<hex hmac-sha256>` over `"{t}.{raw body}"` — so a receiver can reuse verification
code it already has. skein ships the verifier too, from a package that installs with no graph runtime:

```ts
import { verifySkeinSignature } from "@skein-js/agent-protocol";

const result = verifySkeinSignature({
  header: req.headers["x-skein-signature"],
  body: rawBody, // the RAW bytes — see below
  secrets: [process.env.SKEIN_WEBHOOK_SECRET!],
});
if (!result.ok) return res.status(401).end();
```

Three things receivers get wrong, in the order they get them wrong:

1. **Verify the raw bytes, not a re-serialized body.** `JSON.stringify(req.body)` does not reproduce
   what was signed — key order and spacing are not guaranteed to round-trip — so every genuine
   callback fails. In Express: `express.raw({ type: "application/json" })` on that route.
2. **Dedupe on `X-Skein-Delivery-Id`.** Delivery is at-least-once: a POST that timed out _after_ you
   committed is indistinguishable from one that never arrived, so it is retried. The id is stable
   across every retry; the attempt number is in `X-Skein-Attempt`.
3. **Answer 2xx only once the work is durably done.** Answering early and then failing loses the
   callback — the sender heard success. A non-2xx is how you ask for a retry.

The signature covers the timestamp, which is what makes a **replay** detectable with no state on your
side: a captured callback stops verifying once it is outside the tolerance window (5 minutes by
default). A runnable receiver doing all of this — accepting a genuine callback, refusing a forged one
and a replayed one — is in
[`examples/express-basic/src/webhook-receiver.ts`](https://github.com/skein-js/skein-js/blob/main/examples/express-basic/src/webhook-receiver.ts).

Rotate by setting `SKEIN_WEBHOOK_SECRET` to a comma-separated list, new key first: skein signs with
the first and receivers accept any they hold. Remove the old key only once every receiver has the new
one — the other order refuses every callback until they catch up.

> [!WARNING]
> If you inject your own `webhookDispatcher`, it must forward `attempt.headers` and send
> `attempt.body` verbatim, or callbacks go out unsigned while your config says otherwise. skein warns
> at startup when it sees both a signing key and a custom dispatcher.

### See what a callback did, and replay it

```
GET  /threads/{thread_id}/runs/{run_id}/deliveries
POST /threads/{thread_id}/runs/{run_id}/deliveries/{delivery_id}/replay
```

The list carries every attempt's status, count and last error — `?status=dead` narrows it to the ones
that gave up. It reports `payload_bytes` rather than the payload itself; read the state from the run.
Replay makes a delivery due again immediately, and 409s one that already succeeded (its payload was
cleared on delivery, so there is nothing left to resend). Both sit under the `runs` route group, so
`http.disable_runs` and your existing `@auth.on.threads` handler already cover them.

Payloads are capped at `max_payload_bytes` (default 256 KiB) because the body is stored for retries.
Over the cap, `values` is replaced by a truncation marker **inside the body** — so a receiver is told
it is looking at a truncated state rather than left to infer it. Raise the cap, or read the state back
from the API using the `run_id` in the callback.

## Go durable and scale out

Back skein with Postgres (state + checkpoints) and Redis (queue + cross-instance streaming). Your server
code doesn't change — only how `deps` is built.

```ts
import { buildRuntime } from "@skein-js/runtime";
const rt = await buildRuntime({
  configPath: "./langgraph.json",
  store: "postgres",
  queue: "redis",
});
// pass rt.deps to any adapter's { deps }; call rt.dispose() on shutdown
```

Or use the CLI: `skein build` produces a deployable image, `skein up` brings up app + Postgres + Redis via
Compose, and `skein dev --store postgres --queue redis` runs the durable stack locally. Redis is optional
for one instance and **required for more than one**.

## Deploy it

That image runs anywhere you can run a container. [deploy.md](../deploy.md) covers what every platform
needs — Postgres, Redis, the port, the `/ok` probe, pool sizing, SIGTERM draining, SSE through proxies —
with guides for [Cloud Run](../deploy-cloud-run.md), [Railway](../deploy-railway.md),
[Fly.io](../deploy-fly.md), [Render](../deploy-render.md), [AWS](../deploy-aws.md),
[Kubernetes](../deploy-kubernetes.md), [a VPS](../deploy-vps.md), and
[what doesn't work on serverless](../deploy-serverless.md).

## Watch it run

The [console](../console.md) at `/console` shows threads, live run tails, interrupt approvals, time
travel, the store browser and crons — served by your own server, no account and no tunnel. It is **off by
default** in production; opt in with `{"http": {"console": true}}`.

For tracing and metrics, [observability.md](../observability.md) covers the `TelemetrySink` seam and the
LangSmith, PostHog and OpenTelemetry adapters.
