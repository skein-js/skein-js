# Serving

Getting the protocol in front of clients: which adapter, the non-chat surface, and browser access.

## Pick a framework adapter

Every adapter serves the identical protocol and takes the same `{ config } | { deps }` seam — pick the
framework you already run. Each has a **standalone** entry (a dedicated server) and an **embedded** one
(mount beside your existing routes).

| Framework | Package             | Standalone            | Embedded                                                             | Examples                                                                                                                                                                   |
| --------- | ------------------- | --------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Express   | `@skein-js/express` | `createExpressServer` | `skeinRouter`                                                        | [express-basic](https://github.com/skein-js/skein-js/tree/main/examples/express-basic), [embed-graph](https://github.com/skein-js/skein-js/tree/main/examples/embed-graph) |
| Fastify   | `@skein-js/fastify` | `createFastifyServer` | `skeinPlugin`                                                        | [fastify-basic](https://github.com/skein-js/skein-js/tree/main/examples/fastify-basic), [fastify-app](https://github.com/skein-js/skein-js/tree/main/examples/fastify-app) |
| NestJS    | `@skein-js/nestjs`  | `createNestServer`    | `SkeinModule.forRoot`                                                | [nestjs-basic](https://github.com/skein-js/skein-js/tree/main/examples/nestjs-basic), [nestjs-app](https://github.com/skein-js/skein-js/tree/main/examples/nestjs-app)     |
| Next.js   | `@skein-js/nextjs`  | route handlers        | `createSkeinRouteHandlers` (App) · `createSkeinPagesHandler` (Pages) | [nextjs-app](https://github.com/skein-js/skein-js/tree/main/examples/nextjs-app), [nextjs-basic](https://github.com/skein-js/skein-js/tree/main/examples/nextjs-basic)     |

Bun and Deno use [`@skein-js/fetch`](../deploy.md), selected with `skein build --runtime`. For a
framework skein doesn't ship, the adapters are ~40-line shims over one handler table — see
[building-an-adapter.md](../building-an-adapter.md). Mount snippets:
[using-skein.md](../using-skein.md#mount-it-on-your-framework).

## Serve a graph as a plain endpoint

For a classifier, extractor, or a workflow another service calls — no threads, no runs. The request body
**is** the graph input; the response **is** its final state.

```ts
const { router } = await skeinInvokeRouter({ deps: embedInMemoryGraphs({ triage }) });
app.use(router);
// curl -X POST localhost:2024/invoke/triage -d '{"text":"…"}'
```

Working version:
[`invoke-endpoint`](https://github.com/skein-js/skein-js/tree/main/examples/invoke-endpoint) — two
non-chat graphs, no model, no API key. Details:
[serving-a-single-graph.md](../serving-a-single-graph.md).

## CORS for a browser client

CORS is **off by default**. Same-origin needs nothing — see
[`nextjs-app`](https://github.com/skein-js/skein-js/tree/main/examples/nextjs-app), which serves the
protocol and the UI from one app.

```jsonc
// langgraph.json — matches the LangGraph CLI
{ "http": { "cors": { "allow_origins": ["http://localhost:3000"] } } }
```

Or pass `cors` to any adapter (`true` for permissive dev, `false` to force off). Cross-origin example:
[`react-usestream`](https://github.com/skein-js/skein-js/tree/main/examples/react-usestream).
