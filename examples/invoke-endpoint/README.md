# invoke-endpoint — serve graphs as plain HTTP endpoints

> The **simplified** serving surface: one graph, one endpoint, called like a function. For non-chat
> work — a classifier, an extractor, a workflow another service calls.

Part of **[skein-js](../../README.md)**. See [docs/serving-a-single-graph.md](../../docs/serving-a-single-graph.md).

## What this shows

Two deliberately non-chat graphs — no messages, no model, no API key — mounted as endpoints:

| Endpoint               | Graph                             | In         | Out                            |
| ---------------------- | --------------------------------- | ---------- | ------------------------------ |
| `POST /invoke/triage`  | [triage](./src/triage-graph.ts)   | `{ text }` | `{ text, category, priority }` |
| `POST /invoke/extract` | [extract](./src/extract-graph.ts) | `{ text }` | `{ text, emails, urls }`       |

The request body **is** the graph input; the response **is** its final state. There are no threads,
assistants, or runs — if you need those (chat, resumable history, human-in-the-loop), use the full
Agent Protocol instead: [`examples/embed-graph`](../embed-graph).

The app's own `GET /health` route sits alongside the endpoints, untouched — the router claims only
`/invoke/*`.

## Run it

```bash
pnpm --filter @skein-js/example-invoke-endpoint start   # http://127.0.0.1:2024
```

```bash
curl -sX POST localhost:2024/invoke/triage \
  -H 'content-type: application/json' \
  -d '{"text":"Refund charge failed — urgent!"}'
# {"text":"Refund charge failed — urgent!","category":"billing","priority":"P1"}

curl -sX POST localhost:2024/invoke/extract \
  -H 'content-type: application/json' \
  -d '{"text":"Mail ada@example.com or see https://example.com/docs"}'
# {"text":"…","emails":["ada@example.com"],"urls":["https://example.com/docs"]}
```

Stream the intermediate steps instead of waiting for the final state — same endpoint, one header:

```bash
curl -NsX POST localhost:2024/invoke/triage \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"text":"Outage — everything is down"}'
```

## The whole wiring

```ts
const { router } = await skeinInvokeRouter({ deps: embedInMemoryGraphs({ triage, extract }) });
app.use(router);
```

Map keys become endpoints. Swap `embedInMemoryGraphs` for `embedPostgresGraphs`
([`@skein-js/runtime`](../../packages/runtime)) to go durable — nothing else changes.

The same surface exists on every adapter: `skeinInvokePlugin` (Fastify), `SkeinInvokeModule`
(NestJS), `createSkeinInvokeRouteHandlers` (Next.js).

## License

[Apache-2.0](../../LICENSE)
