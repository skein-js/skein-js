# `express-basic` example

A playable skein-js server with **two graphs** declared in one
[`langgraph.json`](./langgraph.json):

| Graph id | File                                         | Needs a key?           | Good for                                                         |
| -------- | -------------------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| `echo`   | [`src/echo-graph.ts`](./src/echo-graph.ts)   | ❌ no                  | Zero-setup protocol/streaming playground — echoes your message.  |
| `agent`  | [`src/agent-graph.ts`](./src/agent-graph.ts) | ✅ `ANTHROPIC_API_KEY` | A real Claude ReAct agent with a tool; token streaming over SSE. |

Both are plain LangGraph.js graphs — skein-js serves them unchanged.

## Run

```bash
cp .env.example .env          # only needed for the `agent` graph
pnpm install
pnpm dev                      # → skein dev --port 2024
```

Then point a client at `http://localhost:2024`:

- Vanilla SDK — `new Client({ apiUrl: "http://localhost:2024" })`, assistant `echo` or `agent`.
- React — the [`react-usestream`](../react-usestream) app; set `NEXT_PUBLIC_SKEIN_ASSISTANT_ID=agent`.

**Smoke test the `echo` graph** (no key needed):

```bash
TID=$(curl -s -X POST http://localhost:2024/threads -H 'content-type: application/json' -d '{}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["thread_id"])')

curl -s -X POST "http://localhost:2024/threads/$TID/runs/wait" \
  -H 'content-type: application/json' \
  -d "{\"assistant_id\":\"echo\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}}"
```

Because these are standard LangGraph.js graphs, the same project also runs under the upstream
`langgraph dev` — which is the point: `skein dev` is a
[drop-in replacement](../../docs/langgraph-cli-compat.md).

## Test

```bash
pnpm test     # unit test for the echo graph (no key, no network)
```
