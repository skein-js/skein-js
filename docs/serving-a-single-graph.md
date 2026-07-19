# Serving a graph as a plain endpoint — the simplified path

> **User guide.** skein's main surface is the full [Agent Protocol](./agent-protocol.md) — threads,
> assistants, runs, streaming, history, human-in-the-loop. That's what a **chat** app needs. Plenty of
> LangGraph work isn't chat: a classifier, an extractor, an enrichment step another service calls. For
> those, this page describes a smaller surface — **one graph, one endpoint, called like a function**.

## Contents

- [Which surface do I want?](#which-surface-do-i-want)
- [The whole thing](#the-whole-thing)
- [The contract](#the-contract)
- [Streaming](#streaming)
- [On every adapter](#on-every-adapter)
- [Auth](#auth)
- [What it deliberately doesn't do](#what-it-deliberately-doesnt-do)
- [API reference](#api-reference)
- [See also](#see-also)

## Which surface do I want?

|                    | Full Agent Protocol                                            | Single-graph invoke                          |
| ------------------ | -------------------------------------------------------------- | -------------------------------------------- |
| Mount              | `skeinRouter` / `skeinPlugin` / `SkeinModule` / route handlers | `skeinInvoke*` / `SkeinInvokeModule`         |
| Endpoint           | `/threads`, `/assistants`, `/runs`, `/store`, …                | `POST /invoke/:graph_id`                     |
| Request            | `{ input, config, stream_mode, … }` on a thread                | the graph input, raw                         |
| Response           | a run object (or an SSE run stream)                            | the final graph state                        |
| Conversation state | persisted per thread (resume, history, time travel)            | **none** — each call is independent          |
| Best for           | chat, HITL, anything resumable                                 | classification, extraction, batch, workflows |
| Clients            | `useStream`, Agent Chat UI, LangGraph SDK                      | `fetch`, `curl`, any HTTP client             |

Both run the _same_ graph through the same LangGraph machinery. The difference is how much protocol
sits in front of it. Mounting both is supported and safe: each call attaches its checkpointer and
store to a per-call clone of the compiled graph, so an invoke never disturbs a concurrent protocol
run's durable state.

## The whole thing

```ts
import { skeinInvokeRouter } from "@skein-js/express";
import { embedInMemoryGraphs } from "@skein-js/server-kit";
import express from "express";

import { graph as triage } from "./triage-graph.js";

const app = express();
const { router } = await skeinInvokeRouter({ deps: embedInMemoryGraphs({ triage }) });
app.use(router);
app.listen(2024);
```

```bash
curl -sX POST localhost:2024/invoke/triage \
  -H 'content-type: application/json' \
  -d '{"text":"Refund charge failed — urgent!"}'
# {"text":"Refund charge failed — urgent!","category":"billing","priority":"P1"}
```

Runnable version: [`examples/invoke-endpoint`](../examples/invoke-endpoint).

## The contract

**The request body is the graph input. The response is the graph's final state.** No envelope in
either direction — the graph behaves like a function over HTTP.

- **One endpoint per graph.** Every id in the graph map (or in `langgraph.json`) is mounted at
  `POST <prefix>/<graph_id>`. The prefix defaults to `/invoke`.
- **An unregistered id is a 404**, with `code: "graph_not_found"`.
- **An empty body runs the graph with its state defaults** rather than surfacing LangGraph's opaque
  `EmptyInputError` — useful for graphs that take no input at all.
- **Responses are serialized with the same wire encoder** the protocol uses, so LangChain messages in
  a final state flatten to the `{ type, content }` shape clients expect.
- **A graph that throws is an error response**, mapped through the adapter's normal error path.

## Streaming

The default is a single JSON response. Send `Accept: text/event-stream` and the _same_ endpoint
streams the graph's steps as SSE instead, ending with a terminal `end` (or `error`) event:

```bash
curl -NsX POST localhost:2024/invoke/triage \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"text":"Outage — everything is down"}'
```

```text
id: 1
event: values
data: {"text":"Outage — everything is down","category":"","priority":""}

id: 2
event: values
data: {"text":"Outage — everything is down","category":"general","priority":""}

event: end
data: {"status":"success"}
```

The mode defaults to `values` (each frame is the full state after a step, ending at the value the JSON
response would have returned). Override it per mount with `streamMode`, or per request with
`?stream_mode=updates` (comma-separate for several). Modes are validated at the boundary, so an
unknown one is a 400 rather than an opaque failure deeper in. If the graph throws mid-stream the
failure arrives as an `error` frame — headers are already sent, so it can't become an HTTP status.

`stream_mode=events` is **not** available here: it is not a Pregel stream mode (the run engine serves
it from `graph.streamEvents`, while this surface drives `graph.stream`), so it is rejected with a 400.
Use the Agent Protocol run endpoints for token-level events.

## On every adapter

The surface is the same everywhere; only the mount idiom differs.

```ts
const deps = embedInMemoryGraphs({ triage, extract });

// Express — a Router you mount
const { router } = await skeinInvokeRouter({ deps });
app.use(router);

// Fastify — a plugin, encapsulated under its prefix
await app.register(skeinInvokePlugin, { prefix: "/agent", deps }); // → POST /agent/invoke/:graph_id

// NestJS — a dynamic module, alongside your controllers
@Module({ imports: [SkeinInvokeModule.forRoot({ deps })] })
export class AppModule {}

// Next.js App Router — app/api/invoke/[graph_id]/route.ts
export const runtime = "nodejs";
export const { POST } = createSkeinInvokeRouteHandlers({ deps, basePath: "/api/invoke" });
```

Each accepts the same `{ config } | { deps }` seam as the full protocol, so
`skeinInvokeRouter({ config: "./langgraph.json" })` works too — see [embedding.md](./embedding.md).
The Express/Fastify/NestJS mounts claim only their own path and pass everything else through, so the
host app's routes are untouched.

## Auth

`deps.auth`, when configured, is enforced here exactly as on a run — invoking a graph _runs_ it
(spending model tokens), so this is not a way around the gate. The caller is authenticated (401 on
failure) and authorized against `threads:create_run` (403 on deny), and the authenticated principal is
stamped into the graph's `configurable` as `langgraph_auth_user`, just like a protocol run.

Auth runs _before_ the graph-exists check, so an unknown id also returns 401 rather than 404 — an
anonymous caller can't enumerate which graphs you serve by telling the two apart.

> **⚠️ With no `auth` configured, this endpoint is open** — the same default as the full protocol
> (and as `langgraph dev`). That's fine behind your own middleware or on a private network; anywhere
> public, wire an `auth` engine before you ship. See [embedding.md](./embedding.md#bring-your-own-drivers-auth-logger).

## What it deliberately doesn't do

Each call is **independent**: no thread is created, nothing is persisted between calls, and the run
never appears in `/runs`. Concretely, this surface has no:

- **conversation state** — no thread id, no history, no time travel;
- **interrupts / human-in-the-loop** — there is no thread to resume into;
- **background runs, run rows, or webhooks** — the call is inline; there is no run to cancel by id;
- **assistants** — you address the `graph_id` directly, with no assistant config layer.

The **long-term store is still injected**, so nodes reach cross-thread memory via `getStore()` as
usual. If you need any of the above, use the full protocol — that's what it's for.

The call's lifetime really is the request: the graph runs under an `AbortSignal` that fires when the
client disconnects (all four adapters wire this) and when `deps.runTimeoutMs` elapses — the same
budget the run engine applies — so a disconnected or hung call doesn't keep burning model tokens.

## API reference

From [`@skein-js/agent-protocol`](../packages/agent-protocol) (the shared handler every adapter wraps):

```ts
// A ProtocolHandler for `POST <prefix>/:graph_id`. Resolves the graph, injects the store, invokes.
function createGraphInvokeHandler(
  deps: ProtocolDeps,
  options?: { streamMode?: StreamMode | StreamMode[] }, // SSE modes; default "values"
): ProtocolHandler;

// The one-route table, shaped like `skeinRoutes` so catch-all adapters can match it identically.
function graphInvokeRoutes(prefix?: string): RouteBinding[]; // default prefix "/invoke"

// Build a matcher over any route table (used by the NestJS/Next.js catch-all mounts).
function createRouteMatcher(bindings: readonly RouteBinding[]): RouteMatcher;
```

Per adapter — each takes `SkeinRuntimeOptions` (`{ config } | { deps }`, plus `logger`/`cors`) and the
`streamMode` option above:

| Adapter | Entry point                               | Path option          |
| ------- | ----------------------------------------- | -------------------- |
| Express | `skeinInvokeRouter(options)`              | `prefix` (`/invoke`) |
| Fastify | `skeinInvokePlugin`                       | `invokePrefix`       |
| NestJS  | `SkeinInvokeModule.forRoot(options)`      | `prefix`             |
| Next.js | `createSkeinInvokeRouteHandlers(options)` | `basePath`           |

From [`@skein-js/server-kit`](../packages/server-kit):

```ts
// Resolve `{ config } | { deps }` to just the deps — no assistants seeded, no run worker started.
function resolveRuntimeDeps(options: SkeinRuntimeOptions): Promise<{ deps: ProtocolDeps; cors? }>;
```

## See also

- [embedding.md](./embedding.md) — bringing a graph in code (`{ deps }`), the on-ramp this builds on
- [agent-protocol.md](./agent-protocol.md) — the full surface, and when you want it instead
- [streaming.md](./streaming.md) — how skein maps run frames onto SSE
- [`examples/invoke-endpoint`](../examples/invoke-endpoint) · [`examples/embed-graph`](../examples/embed-graph)
