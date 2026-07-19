# Using skein-js in your app

A dense, task-oriented cheat-sheet for **consuming** skein-js — pick a framework, stand up an Agent
Protocol server around your LangGraph.js graph, and call it. Written to be skim-friendly for humans
_and_ for AI coding agents building on skein. (Working _on_ skein itself? See
[AGENTS.md](../AGENTS.md).)

## Contents

- [The one thing to know: the `{ config } | { deps }` seam](#the-one-thing-to-know-the--config----deps--seam)
- [Install](#install)
- [Two on-ramps](#two-on-ramps)
- [Mount it on your framework](#mount-it-on-your-framework)
- [Go to production (Postgres + Redis)](#go-to-production-postgres--redis)
- [Call the server](#call-the-server)
- [Endpoint surface](#endpoint-surface)
- [Package → import map](#package--import-map)
- [Expand your setup](#expand-your-setup)
- [Gotchas](#gotchas)
- [Go deeper](#go-deeper)

## The one thing to know: the `{ config } | { deps }` seam

Every framework adapter takes the **same options bag** (`SkeinRuntimeOptions`). You choose one of two
inputs, plus optional common fields:

```ts
// EITHER: let skein build an in-memory runtime from a langgraph.json (dev / zero-setup)
{ config: "./langgraph.json", importModule? }
// OR: bring your own assembled ProtocolDeps (production drivers, custom auth, in-code graphs)
{ deps }
// plus common: { logger?, cors?, warm? }
```

`config` → in-memory drivers, hot-reload, great for dev. `deps` → whatever you assembled (Postgres +
Redis for production, or an in-code graph map). **Same server either way** — only the wiring differs.

## Install

Pick your framework adapter; `@langchain/langgraph` is always a peer dependency (bring your graph).

```bash
pnpm add @skein-js/express  @langchain/langgraph        # Express
pnpm add @skein-js/fastify  @langchain/langgraph        # Fastify
pnpm add @skein-js/nestjs   @langchain/langgraph        # NestJS
pnpm add @skein-js/nextjs   @langchain/langgraph        # Next.js
```

For production drivers add `@skein-js/runtime` (assembles Postgres/Redis). Prefer the CLI on-ramp?
`pnpm add -D skein-js` and run `skein dev` — a drop-in for `langgraph dev`.

## Two on-ramps

**A — You have a `langgraph.json`** (or use the LangGraph CLI today). Change one script and keep the
config unchanged:

```diff
- "dev": "langgraph dev",
+ "dev": "skein dev",
```

Or point an adapter at the config: `{ config: "./langgraph.json" }`. See
[langgraph-cli-compat.md](./langgraph-cli-compat.md).

**B — You have a compiled graph in code** (no config, no CLI). Wrap it into `deps` and pass `{ deps }`:

```ts
import { createExpressServer } from "@skein-js/express";
import { embedInMemoryGraphs } from "@skein-js/server-kit";
import { graph } from "./my-graph.js";

const server = await createExpressServer({ deps: embedInMemoryGraphs({ agent: graph }) });
await server.listen(2024);
```

`embedInMemoryGraphs(graphs, { overrides? })` builds a `ProtocolDeps` (store, queue, bus,
checkpointer). See [embedding.md](./embedding.md).

## Mount it on your framework

Each adapter ships a **standalone** server (`create*Server`) and an **embed-alongside-your-app** path.
All accept the `{ config } | { deps }` seam above.

```ts
// Express — standalone, or skeinRouter({...}) to mount on an existing app
import { createExpressServer } from "@skein-js/express";
const server = await createExpressServer({ config: "./langgraph.json" });
await server.listen(2024);

// Fastify — standalone, or app.register(skeinPlugin, { prefix: "/agent", config })
import { createFastifyServer } from "@skein-js/fastify";
await (await createFastifyServer({ config: "./langgraph.json" })).listen(2024);

// NestJS — imports: [SkeinModule.forRoot({ config: "./langgraph.json" })]
import { createNestServer } from "@skein-js/nestjs";
await (await createNestServer({ config: "./langgraph.json" })).listen(2024);

// Next.js — App Router catch-all: app/api/[...path]/route.ts
import { createSkeinRouteHandlers } from "@skein-js/nextjs";
export const runtime = "nodejs";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createSkeinRouteHandlers({ deps });
```

Each adapter has a **standalone** entry (a dedicated graph server) and an **embed-alongside-your-app**
entry, each with a runnable example:

| Framework | Package             | Standalone (dedicated server)           | Embed in an existing app                                                    | Examples                                                                           |
| --------- | ------------------- | --------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Express   | `@skein-js/express` | `createExpressServer`                   | `skeinRouter` (mount the `Router`)                                          | [express-basic](../examples/express-basic), [embed-graph](../examples/embed-graph) |
| Fastify   | `@skein-js/fastify` | `createFastifyServer`                   | `skeinPlugin` (`register` under a `prefix`)                                 | [fastify-basic](../examples/fastify-basic), [fastify-app](../examples/fastify-app) |
| NestJS    | `@skein-js/nestjs`  | `createNestServer`                      | `SkeinModule.forRoot` (import it)                                           | [nestjs-basic](../examples/nestjs-basic), [nestjs-app](../examples/nestjs-app)     |
| Next.js   | `@skein-js/nextjs`  | — (the route handlers _are_ the server) | `createSkeinRouteHandlers` (App Router) · `createSkeinPagesHandler` (Pages) | [nextjs-app](../examples/nextjs-app), [nextjs-basic](../examples/nextjs-basic)     |

[`embed-graph`](../examples/embed-graph) is the framework-agnostic **in-code** pattern
(`embedInMemoryGraphs` + `{ deps }`, no `langgraph.json`) shown on the Express adapter; the same `deps`
works with any adapter above. [`react-usestream`](../examples/react-usestream) is a browser frontend
for any of them. See [Expand your setup](#expand-your-setup) to grow from here.

### Where to point your client when embedding

The protocol is served wherever you mount it, so set the client's `apiUrl` to the **mount root**, not
the server root. How you set the mount differs per adapter:

```ts
// Express — mount the router under a path
const { router } = await skeinRouter({ deps });
app.use("/agent", router); // → apiUrl: http://localhost:2024/agent

// Fastify — the plugin is encapsulated, so `prefix` isolates skein's routes + CORS
await app.register(skeinPlugin, { prefix: "/agent", deps }); // → .../agent

// NestJS — no skein-side option: it follows your app's global prefix
app.setGlobalPrefix("api"); // → apiUrl: http://localhost:2024/api

// Next.js — the catch-all's location, via `basePath` (defaults to "/api")
// app/api/[...path]/route.ts                                → apiUrl: http://localhost:3000/api
```

Mount at the root (no prefix) and `apiUrl` is just the server root. NestJS is the odd one out: it
reads the mount from the framework rather than from an argument you pass, so there is no skein-side
option to keep in sync with `setGlobalPrefix`.

## Go to production (Postgres + Redis)

Swap the in-memory `deps` for durable ones — everything else stays the same. Two ways:

```ts
// In code: durable deps around graphs you hold (reads POSTGRES_URI / REDIS_URI)
import { embedPostgresGraphs } from "@skein-js/runtime";
import { createExpressServer } from "@skein-js/express";

const { deps, dispose } = await embedPostgresGraphs({ agent: graph });
const server = await createExpressServer({ deps });
await server.listen(2024);
process.on("SIGTERM", () => dispose().then(() => process.exit(0)));
```

```ts
// From a langgraph.json: pick drivers explicitly
import { buildRuntime } from "@skein-js/runtime";
const rt = await buildRuntime({
  configPath: "./langgraph.json",
  store: "postgres",
  queue: "redis",
});
const server = await createExpressServer({ deps: rt.deps, cors: rt.cors });
```

Redis is optional but **required to run more than one instance** (the in-memory queue is
process-local). Or skip the code entirely: `skein dev --store postgres --queue redis`, and
`skein build` / `skein up` for a container. See [embedding.md](./embedding.md#going-to-production),
[storage.md](./storage.md), [runs-and-redis.md](./runs-and-redis.md).

## Call the server

Any Agent Protocol client works — no custom SDK. The two you'll reach for:

```ts
// Node / server-to-server — @langchain/langgraph-sdk
import { Client } from "@langchain/langgraph-sdk";
const client = new Client({ apiUrl: "http://localhost:2024" });
const thread = await client.threads.create();
const input = { messages: [{ role: "user", content: "hello" }] };
const reply = await client.runs.wait(thread.thread_id, "agent", { input });
for await (const ev of client.runs.stream(thread.thread_id, "agent", { input })) console.log(ev);
```

```tsx
// Browser — @langchain/langgraph-sdk/react useStream (SSE)
import { useStream } from "@langchain/langgraph-sdk/react";
const thread = useStream({ apiUrl: "http://localhost:2024", assistantId: "agent" });
thread.submit({ messages: [{ type: "human", content: "hello" }] });
```

`assistantId` defaults to the `graph_id`. See [react-sdk.md](./react-sdk.md),
[streaming.md](./streaming.md).

## Endpoint surface

skein implements the standard Agent Protocol REST + SSE contract, so the SDK maps onto it directly.
The resources: **assistants** (a served graph + its schemas), **threads** (persistent conversations),
**runs** (`/runs/wait`, `/runs/stream`, background `/threads/{id}/runs` with join + cancel), and a
long-term **store** (`/store/items`, semantic `/store/items/search`). The full endpoint inventory and
the auth route→permission map live in [agent-protocol.md](./agent-protocol.md).

## Package → import map

| You want to…                                    | Import                                     | From                       |
| ----------------------------------------------- | ------------------------------------------ | -------------------------- |
| Serve on Express / Fastify / Nest / Next        | `create*Server` / `skein*` / `SkeinModule` | `@skein-js/<framework>`    |
| Embed a graph in code (in-memory)               | `embedInMemoryGraphs`                      | `@skein-js/server-kit`     |
| Embed a graph in code (durable Postgres)        | `embedPostgresGraphs`                      | `@skein-js/runtime`        |
| Assemble prod deps from a `langgraph.json`      | `buildRuntime`                             | `@skein-js/runtime`        |
| Implement a storage driver / handle edge errors | `SkeinStore`, `SkeinHttpError`             | `@skein-js/core`           |
| Put skein on a framework we don't ship          | `skeinRoutes`, `createProtocolRuntime`     | `@skein-js/agent-protocol` |

## Expand your setup

Grow from the minimal server without rewrites — each step changes one thing:

- **Add another graph.** Add an entry to the graph map (`embedInMemoryGraphs({ echo, agent })`) or to
  `langgraph.json`'s `graphs`. Each becomes an assistant, addressed by its `graph_id`.
- **Standalone → embedded.** Move from a dedicated `create*Server` to the embed entry for your
  framework (`skeinRouter` / `skeinPlugin` / `SkeinModule.forRoot` / `createSkein*Handlers`) — see the
  adapter table above — to serve the protocol next to your existing routes, under a prefix if you want.
- **Go durable / scale out.** Swap the in-memory `deps` for `embedPostgresGraphs(...)` or
  `buildRuntime({ store: "postgres", queue: "redis" })`. Add Redis to run more than one instance. See
  [Go to production](#go-to-production-postgres--redis).
- **Add auth, memory, HITL, webhooks.** These are drop-in — see the [recipes](./recipes.md) (custom
  auth, `getStore()` long-term memory, interrupt/resume, run-completion webhooks).
- **A framework we don't ship.** The adapters are thin shims over one transport-neutral handler table
  (`createProtocolRuntime` + `skeinRoutes`); put skein on any Node HTTP framework by writing ~40 lines
  of request/response mapping. See [building-an-adapter.md](./building-an-adapter.md).

## Gotchas

- **Auth is off by default.** No `auth` block / no `auth` dep → the server is fully open, exactly like
  `langgraph dev`. Turn it on with a `@langchain/langgraph-sdk/auth` `Auth` instance — see
  [recipes.md](./recipes.md#custom-auth).
- **CORS is off by default.** Browser clients on another origin need `http.cors` in `langgraph.json`
  (or the `cors` option). Same-origin (e.g. Next.js) needs nothing.
- **A long-lived Node process** is required for the background run worker and in-memory drivers — fine
  on a normal server / `next start`; for serverless, use Postgres + Redis.
- **`useStream` needs an absolute URL** — pass `` `${window.location.origin}/api` ``, not a bare
  `/api`.
- **404s on every protocol path?** You're almost certainly pointing at the wrong root — the protocol
  lives at your **mount path**, not the server root (see
  [Where to point your client](#where-to-point-your-client-when-embedding)). On NestJS that means
  `app.setGlobalPrefix("api")` moves it to `/api/threads`. Two red herrings worth ruling out: an
  `Unsupported route path: "/api/*"` warning in a NestJS boot log is Nest auto-converting the
  adapter's catch-all and is harmless, and `/info` isn't part of the surface — a 404 there is correct.

## Go deeper

- [Getting started](./getting-started.md) — the guided, end-to-end walkthrough.
- [Recipes](./recipes.md) — auth, human-in-the-loop, long-term memory, CORS, background runs, deploy.
- [Overview & architecture](./index.md) · [Agent Protocol surface](./agent-protocol.md) ·
  [Embedding](./embedding.md) · [Building a custom adapter](./building-an-adapter.md)
