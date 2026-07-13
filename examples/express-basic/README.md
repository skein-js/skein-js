# `express-basic` example

A playable skein-js server with **two graphs** declared in one
[`langgraph.json`](./langgraph.json):

| Graph id | File                                         | Needs a key?           | Good for                                                         |
| -------- | -------------------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| `echo`   | [`src/echo-graph.ts`](./src/echo-graph.ts)   | ❌ no                  | Zero-setup protocol/streaming playground — echoes your message.  |
| `agent`  | [`src/agent-graph.ts`](./src/agent-graph.ts) | ✅ `ANTHROPIC_API_KEY` | A real Claude ReAct agent with a tool; token streaming over SSE. |

Both are plain LangGraph.js graphs — skein-js serves them unchanged.

## Status

🚧 The `skein dev` command lands in Phase 1 (see [roadmap](../../docs/roadmap.md)). Until then:

- The **graphs are real** — `pnpm test` exercises the echo graph today.
- Because they are standard LangGraph.js graphs, you can even serve them right now with the
  upstream CLI (`npx @langchain/langgraph-cli dev`) — which is exactly the point: `skein dev`
  will be a [drop-in replacement](../../docs/langgraph-cli-compat.md).

## Run (once `skein dev` exists)

```bash
cp .env.example .env          # only needed for the `agent` graph
pnpm install
pnpm dev                      # skein dev --port 2024
```

Then point a client at it:

- Vanilla SDK — `new Client({ apiUrl: "http://localhost:2024" })`, assistant `echo` or `agent`.
- React — the [`react-usestream`](../react-usestream) app; set `NEXT_PUBLIC_SKEIN_ASSISTANT_ID=agent`.

## Test

```bash
pnpm test     # unit test for the echo graph (no key, no network)
```
