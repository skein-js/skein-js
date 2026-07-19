# @skein-js/express

> Express adapter for skein-js — mount the Agent Protocol on an Express `Router`.

Part of **[skein-js](../../README.md)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — implemented; the v1 framework adapter.

## What it does

Converts Express `req`/`res` into [`@skein-js/agent-protocol`](../agent-protocol)'s normalized
request, dispatches to its handler table, and pipes JSON / `204` / `text/event-stream` responses back
out. It adds **no protocol logic of its own** — it's a thin transport shim. It ships:

- **`createExpressServer`** — a zero-setup server (reads a `langgraph.json`, wires in-memory drivers).
- **`skeinRouter`** — a mountable `Router` for an existing Express app.
- **`createHandlerRouter`** — the pure shim for callers wiring their own `ProtocolDeps`.

## Install

```bash
pnpm add @skein-js/express @langchain/langgraph
```

**`express`** (`>=4.18`) and **`@langchain/langgraph`** are peer dependencies. `express` is almost
always already in your app; add it too if not (`pnpm add express`).

## Usage

The zero-setup server — reads a `langgraph.json`, wires in-memory drivers, and serves the protocol:

```ts
import { createExpressServer } from "@skein-js/express";

const server = await createExpressServer({ config: "./langgraph.json" });
await server.listen(2024); // defaults: port 2024, host "localhost"
// …later:
await server.close();
```

Mount the router on an existing Express app:

```ts
import express from "express";
import { skeinRouter } from "@skein-js/express";

const app = express();
const { router, runtime } = await skeinRouter({ config: "./langgraph.json" });
app.use(router);
app.listen(2024);
// runtime.worker.stop() to drain background runs on shutdown.
```

Bring your own persistent drivers (e.g. Postgres + Redis, assembled by
[`@skein-js/runtime`](../runtime)) through the same `deps` seam:

```ts
import { skeinRouter } from "@skein-js/express";
import { buildRuntime } from "@skein-js/runtime";

const runtime = await buildRuntime({
  configPath: "./langgraph.json",
  store: "postgres",
  queue: "redis",
});
const { router } = await skeinRouter({ deps: runtime.deps, cors: runtime.cors });
app.use(router);
```

## Graphs as plain endpoints (non-chat)

For workloads that aren't chat — a classifier, an extractor, a workflow another service calls — there
is a smaller surface: every graph mounted as `POST /invoke/:graph_id`, where the request body **is**
the graph input and the response **is** the final state. No threads, assistants, or runs.

```ts
import { skeinInvokeRouter } from "@skein-js/express";
import { embedInMemoryGraphs } from "@skein-js/server-kit";

const { router } = await skeinInvokeRouter({ deps: embedInMemoryGraphs({ triage }) });
app.use(router);
// curl -X POST localhost:2024/invoke/triage -d '{"text":"…"}'
```

Send `Accept: text/event-stream` to stream the steps instead. See
[docs/serving-a-single-graph.md](../../docs/serving-a-single-graph.md) and
[`examples/invoke-endpoint`](../../examples/invoke-endpoint).

## API

- **`createExpressServer(options): Promise<SkeinExpressServer>`** — `SkeinExpressServer` =
  `{ app, runtime, listen(port?, host?), close() }`. `listen` defaults to port `2024`, host
  `"localhost"`, resolves the Node `Server` once bound; `close()` stops the run worker then the HTTP
  server (idempotent).
- **`skeinRouter(options): Promise<SkeinRouter>`** — `SkeinRouter` = `{ router, runtime }`.
- **`skeinInvokeRouter(options): Promise<SkeinInvokeRouter>`** — the simplified serving surface
  (`POST /invoke/:graph_id`, body-in / final-state-out). `SkeinInvokeRouter` = `{ router, deps }`;
  options add `prefix` (default `/invoke`) and `streamMode`.
- **`SkeinRouterOptions`** — common `{ logger?, cors?, warm? }` **plus** either `{ config, importModule? }`
  (in-memory runtime from a `langgraph.json`) **or** `{ deps }` (bring-your-own `ProtocolDeps`).
  `warm: true` eagerly loads graphs at startup; `logger` mounts per-request logging.
- **`createHandlerRouter(handlers, options?)`** / **`skeinRoutes`** — the pure route table, for
  composing your own routing over an existing `ProtocolHandlers`.
- **`corsFromHttpConfig(http)`** / **`toCorsOptions(config)`** — map a `langgraph.json` `http.cors`
  block onto `cors` options (`LanggraphCorsConfig`).
- **`loadInMemoryRuntime` / `loadReloadableInMemoryRuntime`** — the in-memory `ProtocolDeps` loaders
  (the reloadable one adds `reloadGraphs` / `snapshotState` / `hydrateState`, powering `skein dev`).
- Low-level mappers: `toProtocolRequest`, `sendProtocolResponse`, `sendErrorResponse`.

## CORS

Browser clients (Agent Chat UI, React `useStream`) run on a different origin. CORS is **off by
default** (non-permissive) and driven by the `http.cors` block of `langgraph.json`, matching the
LangGraph CLI:

```jsonc
{
  "graphs": { "agent": "./agent.ts:graph" },
  "http": { "cors": { "allow_origins": ["http://localhost:3000"] } },
}
```

Override in code with the `cors` option: pass [`CorsOptions`](https://github.com/expressjs/cors#configuration-options)
to restrict origins, `true` for permissive dev, or `false` to force it off.

## Reuse

Thin transport shim over [`@skein-js/agent-protocol`](../agent-protocol); adds no protocol logic of
its own.

## Learn more

- [Agent Protocol surface](../../docs/agent-protocol.md) · [Streaming (SSE)](../../docs/streaming.md) · [React SDK / `useStream`](../../docs/react-sdk.md)
- [skein-js overview](../../docs/index.md) · [Reuse-first architecture](../../docs/reuse.md) · [Root README](../../README.md)

## License

[Apache-2.0](../../LICENSE)
