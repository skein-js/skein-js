# @skein-js/fastify

> Fastify adapter for skein-js — mount the [Agent Protocol](https://github.com/langchain-ai/agent-protocol) as a Fastify plugin.

Part of **[skein-js](../../README.md)** — a TypeScript Agent Protocol server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

A thin transport shim over the framework-agnostic [`@skein-js/agent-protocol`](../agent-protocol)
handler table — it adds no protocol logic, exactly like [`@skein-js/express`](../server-express).

## Install

```bash
npm i @skein-js/fastify fastify @langchain/langgraph
npm i @fastify/cors            # optional — only if you need CORS (browser clients on another origin)
```

## Standalone server

A dedicated server whose only job is to serve your graphs:

```ts
import { createFastifyServer } from "@skein-js/fastify";

const server = await createFastifyServer({ config: "./langgraph.json" });
await server.listen(2024);
// point the @langchain/langgraph-sdk `Client` (or React `useStream`) at http://localhost:2024
// on shutdown: await server.close();
```

Pass `{ deps }` instead of `{ config }` to bring your own persistent drivers (Postgres + Redis) via
[`@skein-js/runtime`](../runtime)'s `buildRuntime`.

## Embedded in an existing app

Register `skeinPlugin` under a prefix to serve the protocol alongside your app's own routes. It is
encapsulated, so skein's routes and CORS stay isolated:

```ts
import Fastify from "fastify";
import { skeinPlugin } from "@skein-js/fastify";

const app = Fastify();
app.get("/health", async () => ({ ok: true })); // your own routes
await app.register(skeinPlugin, { prefix: "/agent", config: "./langgraph.json" });
await app.listen({ port: 3000 });
// the Agent Protocol is now served under /agent/*
```

## Streaming

SSE responses take over the raw Node response (`reply.hijack()` + `reply.raw`) and stream the
pre-serialized frames the engine produced, tearing the run's subscription down on client disconnect.

## Learn more

- [`@skein-js/express`](../server-express) — the reference adapter
- [Building your own adapter](../../docs/building-an-adapter.md) · [skein-js overview](../../docs/index.md)

## License

[Apache-2.0](../../LICENSE)
