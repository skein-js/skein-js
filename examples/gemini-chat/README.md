# `gemini-chat` example

The **model-backed end-to-end** demo: a real **Gemini** ReAct agent served by `skein dev` and
streamed token-by-token into a browser. It also ships a **programmatic** `@skein-js/express` server
([`src/server.ts`](./src/server.ts)) that embeds the same graph in your own Node process. The whole
thing runs against your own Gemini key, with only a URL pointing the client at skein-js.

| Graph id | File                                           | Needs a key?        | What it is                                                        |
| -------- | ---------------------------------------------- | ------------------- | ----------------------------------------------------------------- |
| `gemini` | [`src/gemini-graph.ts`](./src/gemini-graph.ts) | ✅ `GOOGLE_API_KEY` | A Gemini ReAct agent with a `get_weather` tool; streams over SSE. |

It's a plain LangGraph.js graph (`createAgent` with `ChatGoogleGenerativeAI`) — skein-js serves
it unchanged.

## What you'll learn

- **SSE token streaming from a real model.** A live Gemini reply streams into the browser
  token-by-token, with the `get_weather` tool round-tripping on the way.
- **CORS from `langgraph.json`.** skein's CORS is off by default; the config opens
  `http://localhost:3005` (the `react-usestream` frontend) so a browser can connect.
- **Embedding skein-js in your own server.** [`src/server.ts`](./src/server.ts) uses
  `createExpressServer` from `@skein-js/express` to serve the same graph without the CLI.

## How to run

Get a Gemini Developer API key from <https://aistudio.google.com/apikey>.

**Backend** — in one terminal:

```bash
cp .env.example .env          # paste your GOOGLE_API_KEY
pnpm install
pnpm dev                      # → skein dev --port 2024, serving the `gemini` graph
```

The server listens on `http://localhost:2024`. Point any Agent Protocol client at it:

- Vanilla SDK — `new Client({ apiUrl: "http://localhost:2024" })`, assistant `gemini`.
- React — the [`react-usestream`](../react-usestream) app (see its README); it defaults to the
  `gemini` assistant.

**Frontend** — stream it in a browser (second terminal):

```bash
cd ../react-usestream
cp .env.local.example .env.local   # already points at :2024, assistant `gemini`
pnpm install
pnpm dev                            # → next dev on http://localhost:3005
```

Open <http://localhost:3005>, ask _"what's the weather in Nairobi?"_, and watch Gemini's reply stream
in token-by-token (the `get_weather` tool round-trips on the way).

### Test

```bash
# Drives a live Gemini model through the official @langchain/langgraph-sdk client.
# Skips automatically when GOOGLE_API_KEY is unset.
GOOGLE_API_KEY=... pnpm exec vitest run
```

## What to look at

- [`src/gemini-graph.ts`](./src/gemini-graph.ts) — the Gemini ReAct agent and its `get_weather` tool.
- [`src/server.ts`](./src/server.ts) — the programmatic `createExpressServer` embedding path.
- [`langgraph.json`](./langgraph.json) — the `gemini` graph declaration and the CORS allow-list.
