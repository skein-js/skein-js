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

## Graphs as plain endpoints (non-chat)

For workloads that aren't chat — a classifier, an extractor, a workflow another service calls — there
is a smaller surface: every graph mounted as `POST <basePath>/:graph_id`, where the request body **is**
the graph input and the response **is** the final state. No threads, assistants, or runs.

```ts
// app/api/invoke/[graph_id]/route.ts
import { createSkeinInvokeRouteHandlers } from "@skein-js/nextjs";

export const runtime = "nodejs";
export const { POST } = createSkeinInvokeRouteHandlers({ deps, basePath: "/api/invoke" });
```

Send `Accept: text/event-stream` to stream the steps instead. See
[docs/serving-a-single-graph.md](../../docs/serving-a-single-graph.md).

## Deployment caveat

The background run worker and the in-memory driver need a **long-lived Node process** — fine on
`next start` with `runtime = "nodejs"`. For serverless/edge deploys, back skein with the
[Redis queue](../runtime-redis) + [Postgres store](../storage-postgres) (pass `{ deps }` from
[`@skein-js/runtime`](../runtime)'s `buildRuntime`) so state and runs don't depend on one process.

## API

- **`createSkeinRouteHandlers(options): SkeinRouteHandlers`** — App Router (recommended); returns
  `{ GET, POST, PUT, PATCH, DELETE, OPTIONS }` to re-export from `app/<base>/[...path]/route.ts`.
- **`createSkeinPagesHandler(options): SkeinPagesHandler`** — Pages Router; the default export for
  `pages/api/[...path].ts`.
- **`createSkeinInvokeRouteHandlers(options): SkeinInvokeRouteHandlers`** — the simplified serving
  surface (`POST <basePath>/:graph_id`, body-in / final-state-out); returns `{ POST, OPTIONS }` for
  `app/api/invoke/[graph_id]/route.ts`. `basePath` defaults to `/api/invoke`; adds `streamMode`.
- Both accept `SkeinRouteHandlerOptions` / `SkeinPagesHandlerOptions`: the shared
  `{ config, importModule? } | { deps }` seam **plus** an optional `cors` (off by default) and a
  `basePath` (defaults to `/api`, matching the mount). `deps` comes from
  [`@skein-js/runtime`](../runtime)'s `buildRuntime` for production Postgres/Redis.
- **`getSkeinRuntime(options): Promise<ResolvedProtocolRuntime>`** — the memoized runtime accessor
  shared by both routers (survives dev module reloads); its `.runtime` is the `ProtocolRuntime`
  (assistants, handlers, worker).
- **`SkeinRuntimeOptions`** — the shared runtime-resolution option shape, re-exported for typing your
  own wrappers.
- Low-level serializers: `toWebResponse` / `webErrorResponse` (Web `Response`), plus
  `sendNodeResponse` / `sendNodeError` (re-exported from [`@skein-js/server-kit`](../server-kit)).

## Learn more

- [`@skein-js/express`](../server-express) — the reference adapter
- [Building your own adapter](../../docs/building-an-adapter.md) · [skein-js overview](../../docs/index.md)

## License

[Apache-2.0](../../LICENSE)
