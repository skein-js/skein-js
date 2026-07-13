# `react-usestream` example

A minimal Next.js app that streams from a **Skein** server using
[`@langchain/langgraph-sdk/react`](https://www.npmjs.com/package/@langchain/langgraph-sdk)'s
`useStream` hook. It is the front-end harness for verifying that Skein's SSE wiring
satisfies the LangChain React SDK — token-by-token streaming in a real browser.

See [`../../docs/react-sdk.md`](../../docs/react-sdk.md).

## Status

🚧 Placeholder for Phase 0. It compiles against `useStream` and points at a placeholder
Skein URL, but there is **no Skein server yet** — it becomes runnable once
[`skein dev`](../../docs/langgraph-cli-compat.md) lands (Phase 1, milestone 6).

## Run (once a Skein server exists)

```bash
cp .env.local.example .env.local   # set NEXT_PUBLIC_SKEIN_URL / assistant id
pnpm install
pnpm dev                           # http://localhost:3005
```
