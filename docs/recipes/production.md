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

**It is best-effort and unsigned.** A failed delivery is logged, never retried, and never fails the run —
treat it as a notification and the API as the source of truth. Each POST is aborted after
`SKEIN_WEBHOOK_TIMEOUT_MS` (default 5s), sized against the 8s shutdown budget so a slow receiver can't
get you killed mid-POST. Delivery happens after the thread's execution lock is released, so a slow target
no longer blocks other runs on that thread — which also means two webhooks for one thread are not
guaranteed to arrive in run order.

A server accepting untrusted clients should inject a `webhookDispatcher` that allowlists the host.
Durable, signed, retried delivery is [proposed](../proposals/durable-delivery.md).

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
