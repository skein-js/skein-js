# `react-usestream` example

The **frontend harness**: a minimal Next.js app that streams from **any** skein-js server using
[`@langchain/langgraph-sdk/react`](https://github.com/langchain-ai/langgraphjs/tree/main/libs/sdk)'s
`useStream` hook. Point it at a backend, send a message, and watch the reply stream in
token-by-token in a real browser.

See [`../../docs/react-sdk.md`](../../docs/react-sdk.md).

## What you'll learn

- **How a browser consumes a skein-js SSE server.** The `useStream` hook subscribes to the Agent
  Protocol stream and renders tokens as they arrive — the front-end signal that skein-js's SSE wiring
  satisfies the LangChain React SDK.
- **Retargeting via env.** `NEXT_PUBLIC_SKEIN_URL` and `NEXT_PUBLIC_SKEIN_ASSISTANT_ID` aim the app
  at any skein-js server and graph id — no code change.

## How to run

This is the frontend half of an end-to-end demo. Start a skein-js backend first, then this app.

1. **Backend** — in one terminal, run the [`gemini-chat`](../gemini-chat) example (a real Gemini
   agent), which listens on `http://localhost:2024` and serves the `gemini` assistant:

   ```bash
   cd ../gemini-chat
   cp .env.example .env               # paste your GOOGLE_API_KEY
   pnpm install && pnpm dev           # → skein dev --port 2024
   ```

2. **Frontend** — in a second terminal:

   ```bash
   cp .env.local.example .env.local   # already points at :2024, assistant `gemini`
   pnpm install
   pnpm dev                           # → next dev on http://localhost:3005
   ```

Open <http://localhost:3005>, send a message, and watch the reply stream in token-by-token.

> **Point it anywhere.** Set `NEXT_PUBLIC_SKEIN_URL` and `NEXT_PUBLIC_SKEIN_ASSISTANT_ID` to aim this
> at any skein-js server and graph id (e.g. the [`express-basic`](../express-basic) `agent` graph).

## What to look at

- [`app/page.tsx`](./app/page.tsx) — the entire `useStream` wiring:
  `useStream({ apiUrl, assistantId })`, then `thread.submit({ messages: [{ type: "human", content }] })`
  to send a turn and render `thread.messages` as tokens stream in.
