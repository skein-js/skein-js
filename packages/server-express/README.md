# @skein/express

> Express adapter for Skein — mount the Agent Protocol on an Express Router.

Part of **[Skein](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — not yet implemented (Phase 1).

## What it does

Converts Express `req`/`res` into the core's normalized request, dispatches to the handler table, and pipes JSON + `text/event-stream` responses back out. Ships a `createExpressServer(config)` convenience and a mountable `Router`.

## Reuse

Thin transport shim over [`@skein/core`](../core); adds no protocol logic of its own.

## Install

```bash
pnpm add @skein/express
```

## Usage

```ts
import express from "express";
import { skeinRouter } from "@skein/express";

const app = express();
app.use(await skeinRouter({ config: "./langgraph.json" }));
app.listen(2024);
```

## Learn more

- [Skein overview](../../docs/index.md)
- [Reuse-first architecture](../../docs/reuse.md)
- [Roadmap](../../docs/roadmap.md)

## License

[Apache-2.0](../../LICENSE)
