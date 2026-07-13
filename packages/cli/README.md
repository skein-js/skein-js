# skein

> The Skein CLI — a drop-in replacement for the LangGraph CLI (dev/up/build/dockerfile).

Part of **[Skein](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — not yet implemented (Phase 1).

## What it does

`skein dev` (in-process, hot reload, no Docker), `skein up` (Docker Compose: app + Postgres + Redis), `skein build` / `skein dockerfile`. The one-word swap from `langgraph dev` → `skein dev`.

## Reuse

Mirrors `@langchain/langgraph-cli` semantics and reads an unchanged `langgraph.json`. Reuses `@skein/config` (built on `@langchain/langgraph-api`'s parser) for graph loading.

## Install

```bash
pnpm add skein
```

## Usage

```ts
# swap in package.json scripts:
#   "dev": "skein dev"
#   "up":  "skein up"
npx skein dev --port 2024
```

## Learn more

- [Skein overview](../../docs/index.md)
- [Reuse-first architecture](../../docs/reuse.md)
- [Roadmap](../../docs/roadmap.md)

## License

[Apache-2.0](../../LICENSE)
