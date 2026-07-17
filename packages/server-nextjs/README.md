# @skein-js/nextjs

> Next.js adapter for skein-js — serve the [Agent Protocol](https://github.com/langchain-ai/agent-protocol) from Next.js API routes.

Part of **[skein-js](../../README.md)** — a TypeScript Agent Protocol server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

A thin transport shim over the framework-agnostic [`@skein-js/agent-protocol`](../agent-protocol)
handler table — it adds no protocol logic. Mount the protocol **same-origin** inside an existing
Next.js app (no separate server, no CORS), ideal for small/medium graphs shipped alongside your
frontend. Supports both the **App Router** and the **Pages Router**.

## Install

```bash
npm i @skein-js/nextjs @langchain/langgraph
```

## App Router (recommended)

A catch-all route re-exports the per-method handlers:

```ts
// app/api/[...path]/route.ts
import { createSkeinRouteHandlers } from "@skein-js/nextjs";

export const runtime = "nodejs"; // the background run worker needs a long-lived Node process
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createSkeinRouteHandlers({
  config: "./langgraph.json",
});
```

Point a browser client at the same origin — no CORS needed:

```ts
import { useStream } from "@langchain/langgraph-sdk/react";
const thread = useStream({ apiUrl: "/api", assistantId: "agent" });
```

## Pages Router

```ts
// pages/api/[...path].ts
import { createSkeinPagesHandler } from "@skein-js/nextjs";

// Let Next know this route settles the response itself (needed for SSE streaming).
export const config = { api: { bodyParser: true, externalResolver: true } };
export default createSkeinPagesHandler({ config: "./langgraph.json" });
```

Both entry points accept the shared `{ config } | { deps }` seam, an optional `cors` (off by default),
and a `basePath` (defaults to `/api`, matching the mount above).

## Deployment caveat

The background run worker and the in-memory driver need a **long-lived Node process** — fine on
`next start` with `runtime = "nodejs"`. For serverless/edge deploys, back skein with the
[Redis queue](../runtime-redis) + [Postgres store](../storage-postgres) (pass `{ deps }` from
[`@skein-js/runtime`](../runtime)'s `buildRuntime`) so state and runs don't depend on one process.

## Learn more

- [`@skein-js/express`](../server-express) — the reference adapter
- [Building your own adapter](../../docs/building-an-adapter.md) · [skein-js overview](../../docs/index.md)

## License

[Apache-2.0](../../LICENSE)
