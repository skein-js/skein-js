# Recipes

Task-oriented snippets for the things people build on skein-js after the
[getting-started](./getting-started.md) walkthrough. Each recipe is a problem, the smallest code that
solves it, and links to the deeper doc. For a terse API reference, see
[using-skein.md](./using-skein.md).

## Contents

- [Choose & expand a framework adapter](#choose--expand-a-framework-adapter)
- [Custom auth](#custom-auth)
- [Read the caller inside a graph](#read-the-caller-inside-a-graph)
- [Human-in-the-loop (interrupt / resume)](#human-in-the-loop-interrupt--resume)
- [Long-term memory (`getStore()`)](#long-term-memory-getstore)
- [Semantic memory search (pgvector)](#semantic-memory-search-pgvector)
- [CORS & browser clients](#cors--browser-clients)
- [Background runs, join & cancel](#background-runs-join--cancel)
- [Run-completion webhooks](#run-completion-webhooks)
- [Deploy](#deploy)

## Choose & expand a framework adapter

**Problem:** which adapter (and which example) do you start from, and how do you grow it? Every adapter
serves the identical protocol and takes the same `{ config } | { deps }` seam — pick by the framework
you already run. Each ships a **standalone** entry (a dedicated server) and an **embedded** entry
(mount alongside your app's own routes), with a runnable example for both:

| Framework | Package             | Standalone            | Embedded                                                             | Examples                                                                           |
| --------- | ------------------- | --------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Express   | `@skein-js/express` | `createExpressServer` | `skeinRouter`                                                        | [express-basic](../examples/express-basic), [embed-graph](../examples/embed-graph) |
| Fastify   | `@skein-js/fastify` | `createFastifyServer` | `skeinPlugin`                                                        | [fastify-basic](../examples/fastify-basic), [fastify-app](../examples/fastify-app) |
| NestJS    | `@skein-js/nestjs`  | `createNestServer`    | `SkeinModule.forRoot`                                                | [nestjs-basic](../examples/nestjs-basic), [nestjs-app](../examples/nestjs-app)     |
| Next.js   | `@skein-js/nextjs`  | route handlers        | `createSkeinRouteHandlers` (App) · `createSkeinPagesHandler` (Pages) | [nextjs-app](../examples/nextjs-app), [nextjs-basic](../examples/nextjs-basic)     |

**How to expand from any of them:**

- **Add a graph** — extend the graph map (`embedInMemoryGraphs({ echo, agent })`) or `langgraph.json`'s
  `graphs`; each new graph is another assistant.
- **Standalone → embedded** — switch the standalone `create*Server` for your framework's embed entry
  (the table's Embedded column) to serve the protocol beside your existing routes, under a prefix.
- **Go durable / multi-instance** — replace the in-memory deps with `embedPostgresGraphs(...)` or
  `buildRuntime({ store: "postgres", queue: "redis" })` (see [Deploy](#deploy)).
- **A framework skein doesn't ship** — the adapters are ~40-line shims over one transport-neutral
  handler table (`createProtocolRuntime` + `skeinRoutes`); write your own with
  [building-an-adapter.md](./building-an-adapter.md).

Copy-paste mount snippets for each framework are in
[using-skein.md](./using-skein.md#mount-it-on-your-framework).

## Custom auth

**Problem:** the server is open by default; you want authenticated, per-owner access. skein implements
LangGraph's custom-auth model — export a `@langchain/langgraph-sdk/auth` `Auth` instance (the same
class LangGraph Platform uses, so an existing file is drop-in):

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
  .on("threads", ({ user }) => ({ owner: user.identity })); // scope threads (+ their runs) by owner
```

Wire it in one of two ways:

```jsonc
// langgraph.json (CLI / { config } path)
{ "graphs": { "agent": "./agent.ts:graph" }, "auth": { "path": "./auth.ts:auth" } }
```

```ts
// in code ({ deps } path) — pass it as an override
embedInMemoryGraphs({ agent: graph }, { overrides: { auth } });
// or embedPostgresGraphs({ agent: graph }, { overrides: { auth } });
```

A returned filter both hides other owners' rows on reads and stamps ownership onto new rows. See
[langgraph-cli-compat.md](./langgraph-cli-compat.md#authentication--authorization-auth) and the full
request lifecycle + route→permission map in
[agent-protocol.md](./agent-protocol.md#authentication--authorization).

## Read the caller inside a graph

**Problem:** a node or tool needs to know who's calling. skein injects the authenticated principal into
the run config, exactly as LangGraph Platform does — three server-owned, unspoofable keys:

```ts
async function node(state, config) {
  const user = config.configurable.langgraph_auth_user; // full user object (custom fields included)
  const userId = config.configurable.langgraph_auth_user_id; // the caller's identity
  const scopes = config.configurable.langgraph_auth_permissions; // their scopes
  // …
}
```

These are present only when an `auth` engine is configured; without it, nothing is added (identical to
`langgraph dev`). Details in [agent-protocol.md](./agent-protocol.md#authentication--authorization).

## Human-in-the-loop (interrupt / resume)

**Problem:** pause a run for approval, then resume it later. This is LangGraph-native — skein reuses the
checkpointer so `interrupt()` and resume work unchanged. In the graph:

```ts
import { interrupt } from "@langchain/langgraph";

async function approve(state) {
  const decision = interrupt({ question: "Send this email?", draft: state.draft });
  return decision === "yes" ? { sent: true } : { sent: false };
}
```

The run pauses (the thread's status becomes `interrupted`) and the interrupt surfaces in the stream.
Resume by sending a command to the thread — `POST /threads/{thread_id}/commands` (the SDK's run-with-
command / `useStream` submit carries the resume value). The frontend gets the interrupt and the resume
for free through [`useStream`](./react-sdk.md). Endpoint details:
[agent-protocol.md](./agent-protocol.md#thread-streaming-sse); streaming shape:
[streaming.md](./streaming.md).

## Long-term memory (`getStore()`)

**Problem:** remember a fact about a user across threads/sessions. The long-term store is injected into
every run as a LangGraph `BaseStore`, so a node reads/writes it the native way — and skein swaps the
backend (in-memory in `skein dev`, Postgres in production) with no code change:

```ts
import { getStore } from "@langchain/langgraph";

async function remember(state, config) {
  const store = getStore();
  const userId = config.configurable.langgraph_auth_user_id ?? "anon";
  await store.put(["memories", userId], "prefs", { units: "metric" });
  const hits = await store.search(["memories", userId], { query: "units" });
  return { known: hits.map((h) => h.value) };
}
```

The same items are reachable over the `/store/items` HTTP endpoints. See
[storage.md](./storage.md#long-term-memory-in-the-graph-getstore); the flagship
[`chat-app`](../examples/chat-app) uses this to remember a user across sessions.

## Semantic memory search (pgvector)

**Problem:** `store.search({ query })` should rank by meaning, not substring. On the Postgres driver,
configure an embedder in `langgraph.json`; search then uses pgvector (memory falls back to a naive
scan, so behavior matches in dev):

```jsonc
// langgraph.json
{
  "store": {
    "index": { "embed": "openai:text-embedding-3-small", "dims": 1536, "fields": ["$"] },
    "ttl": { "default_ttl": 1440, "refresh_on_read": true, "sweep_interval_minutes": 60 },
  },
}
```

`embed` accepts a `provider:model` string or a custom-function path; `dims` is required when `embed`
is set. `store.ttl` (minutes) expires items with a background sweep. See
[storage.md](./storage.md#store-item-ttl).

## CORS & browser clients

**Problem:** a browser app on another origin (Agent Chat UI, a `useStream` frontend) is blocked. CORS is
**off by default**. Turn it on with the config block (matches the LangGraph CLI):

```jsonc
// langgraph.json
{
  "graphs": { "agent": "./agent.ts:graph" },
  "http": { "cors": { "allow_origins": ["http://localhost:3000"] } },
}
```

Or in code, pass the `cors` option to any adapter (`CorsOptions`, `true` for permissive dev, `false` to
force off). **Same-origin needs nothing** — serve the protocol and the UI from one app, like
[`nextjs-app`](../examples/nextjs-app). See the
[Express adapter CORS notes](../packages/server-express/README.md#cors).

## Background runs, join & cancel

**Problem:** kick off a long run, return immediately, and stream it from elsewhere. Create a
thread-scoped background run, then join its stream (a client on any instance can join when Redis is
configured) or cancel it:

```ts
import { Client } from "@langchain/langgraph-sdk";
const client = new Client({ apiUrl: "http://localhost:2024" });
const input = { messages: [{ role: "user", content: "research skein-js" }] };

const run = await client.runs.create(threadId, "agent", { input }); // returns immediately
for await (const ev of client.runs.joinStream(threadId, run.run_id)) console.log(ev); // join later
await client.runs.cancel(threadId, run.run_id); // POST /runs/{id}/cancel
```

Cross-instance join and fan-out need the Redis queue + event bus — see
[runs-and-redis.md](./runs-and-redis.md) and [streaming.md](./streaming.md). Concurrent runs on one
thread follow a `multitask_strategy` (Agent Protocol parity); how many background runs execute at
once across _different_ threads is [run concurrency](./runs-and-redis.md#run-concurrency)
(`--concurrency`, default 10).

## Run-completion webhooks

**Problem:** be notified when a background run finishes without polling. Pass a `webhook` URL on run
creation; skein POSTs the settled run (its final `values`, or an `error`) to that URL from the run
engine's terminal path:

```ts
const input = { messages: [{ role: "user", content: "research skein-js" }] };
await client.runs.create(threadId, "agent", { input, webhook: "https://example.com/hooks/run" });
```

The default dispatcher restricts the scheme to `http(s)`. A server that accepts untrusted clients
should inject a `webhookDispatcher` (via `overrides`) that allowlists the target host — the default
stays permissive because internal targets are legitimate in a self-hosted setup. See
[roadmap.md](./roadmap.md).

## Deploy

**Problem:** ship it durably and scale out. Back skein with Postgres (state + checkpoints) and Redis
(queue + cross-instance streaming); nothing about your server code changes, only how `deps` is built:

```ts
import { buildRuntime } from "@skein-js/runtime";
const rt = await buildRuntime({
  configPath: "./langgraph.json",
  store: "postgres",
  queue: "redis",
});
// pass rt.deps to any adapter's { deps }; call rt.dispose() on shutdown
```

Or containerize with the CLI: `skein build` produces a deployable image (app + your graphs), `skein up`
brings up app + Postgres + Redis via Compose, and `skein dev --store postgres --queue redis` runs the
durable stack locally. Redis is optional for a single instance but **required to run more than one**.

That image runs anywhere you can run a container — **[deploy.md](./deploy.md)** covers what every
platform needs, with step-by-step guides for
[Cloud Run](./deploy-cloud-run.md), [Railway](./deploy-railway.md), [Fly.io](./deploy-fly.md),
[Render](./deploy-render.md), [AWS](./deploy-aws.md), [Kubernetes](./deploy-kubernetes.md),
[a plain VPS](./deploy-vps.md), and [what doesn't work on serverless](./deploy-serverless.md).
See also [embedding.md](./embedding.md#going-to-production) and
[runs-and-redis.md](./runs-and-redis.md).
