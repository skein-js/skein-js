# `express-basic` example

The **hello world**: a zero-setup skein-js server with **two graphs** declared in one
[`langgraph.json`](./langgraph.json) — a deterministic `echo` graph that needs no API key, and a real
Gemini `agent` that streams over SSE.

| Graph id | File                                         | Needs a key?        | Good for                                                         |
| -------- | -------------------------------------------- | ------------------- | ---------------------------------------------------------------- |
| `echo`   | [`src/echo-graph.ts`](./src/echo-graph.ts)   | ❌ no               | Zero-setup protocol/streaming playground — echoes your message.  |
| `agent`  | [`src/agent-graph.ts`](./src/agent-graph.ts) | ✅ `GOOGLE_API_KEY` | A real Gemini ReAct agent with a tool; token streaming over SSE. |

Both are plain LangGraph.js graphs — skein-js serves them unchanged.

```json
{
  "node_version": "20",
  "graphs": {
    "echo": "./src/echo-graph.ts:graph",
    "agent": "./src/agent-graph.ts:graph"
  },
  "env": ".env"
}
```

## What you'll learn

- **Multiple graphs in one `langgraph.json`.** Two assistants (`echo`, `agent`) served side by side
  from a single config.
- **A zero-key playground.** The `echo` graph needs no API key or network — the fastest way to poke
  at the Agent Protocol and SSE streaming.
- **Drop-in compatibility.** Because these are standard LangGraph.js graphs, the same project also
  runs under the upstream `langgraph dev` — which is the point: `skein dev` is a
  [drop-in replacement](../../docs/langgraph-cli-compat.md).

## How to run

```bash
cp .env.example .env          # only needed for the `agent` graph; `echo` needs nothing
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

### Test

```bash
pnpm test     # unit test for the echo graph (no key, no network)
```

## What to look at

- [`src/echo-graph.ts`](./src/echo-graph.ts) — the deterministic, zero-dependency graph.
- [`src/agent-graph.ts`](./src/agent-graph.ts) — the Gemini ReAct agent with a `get_weather` tool.
- [`langgraph.json`](./langgraph.json) — the multi-graph declaration.
