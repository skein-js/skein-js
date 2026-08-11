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
"the run finished" and "someone was told" cannot lose it. skein attempts the first delivery inline, so
a healthy receiver hears within milliseconds; a failure is recorded and retried — for about 34 minutes
by default, which rides out a rolling deploy.

**It is at-least-once, not exactly-once.** A retry can duplicate a callback your receiver already
processed — after a network timeout that actually succeeded, say. Every attempt carries the same
`X-Skein-Delivery-Id`; dedupe on it. The API remains the source of truth for run state.

Set `SKEIN_WEBHOOK_SECRET` and every callback is signed, so a receiver can tell a real one from
anybody who guessed the URL:

```ts
import { verifySkeinSignature } from "@skein-js/agent-protocol";

const result = verifySkeinSignature({
  header: req.headers["x-skein-signature"],
  body: rawBody, // the RAW bytes, not JSON.stringify(req.body)
  secrets: [process.env.SKEIN_WEBHOOK_SECRET!],
});
if (!result.ok) return res.status(401).end();
```

Working receiver: `src/webhook-receiver.ts` in
[`examples/express-basic`](https://github.com/skein-js/skein-js/tree/main/examples/express-basic)
(`pnpm webhook-receiver`) — accepts a genuine callback, refuses a forged and a replayed one.

**Run Redis in production**: without it a retry still waiting is lost on exit (the delivery is not).
Details — the retry tiers, signature verification and key rotation, listing and replaying failed
deliveries, and what gets stored and for how long: [webhooks.md](../webhooks.md).

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
