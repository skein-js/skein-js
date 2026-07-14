# @skein-js/express

> Express adapter for skein-js — mount the Agent Protocol on an Express Router.

Part of **[skein-js](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — implemented; the v1 framework adapter.

## What it does

Converts Express `req`/`res` into [`@skein-js/agent-protocol`](../agent-protocol)'s normalized request, dispatches to its handler table, and pipes JSON / `204` / `text/event-stream` responses back out. Ships a `createExpressServer` convenience, a `skeinRouter` that returns a mountable `Router`, and the pure `createHandlerRouter` shim for callers wiring their own drivers.

## Reuse

Thin transport shim over [`@skein-js/agent-protocol`](../agent-protocol); adds no protocol logic of its own.

## Install

```bash
pnpm add @skein-js/express
```

## Usage

The zero-setup server — reads a `langgraph.json`, wires in-memory drivers, and serves the Agent Protocol:

```ts
import { createExpressServer } from "@skein-js/express";

const server = await createExpressServer({ config: "./langgraph.json" });
await server.listen(2024);
// ...later: await server.close();
```

Or mount the router on an existing Express app:

```ts
import express from "express";
import { skeinRouter } from "@skein-js/express";

const app = express();
const { router, runtime } = await skeinRouter({ config: "./langgraph.json" });
app.use(router);
app.listen(2024);
// runtime.worker.stop() to drain background runs on shutdown.
```

Bring your own persistent drivers (e.g. Postgres + Redis for `skein up`) through the same seam:

```ts
const { router } = await skeinRouter({ deps: myProtocolDeps });
```

### CORS

Browser clients (Agent Chat UI, React `useStream`) run on a different origin. CORS is **off by default** (non-permissive) and driven by the `http.cors` block of `langgraph.json`, matching the LangGraph CLI:

```jsonc
{
  "graphs": { "agent": "./agent.ts:graph" },
  "http": { "cors": { "allow_origins": ["http://localhost:3000"] } },
}
```

Override in code with the `cors` option: pass [`CorsOptions`](https://github.com/expressjs/cors#configuration-options) to restrict origins, `true` for permissive dev, or `false` to force it off.

## Learn more

- [skein-js overview](../../docs/index.md)
- [Reuse-first architecture](../../docs/reuse.md)
- [Roadmap](../../docs/roadmap.md)

## License

[Apache-2.0](../../LICENSE)
