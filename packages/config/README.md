# @skein/config

> langgraph.json parser and graph loader (path:export) for Skein.

Part of **[Skein](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — not yet implemented (Phase 1).

## What it does

Reads an existing `langgraph.json` unchanged, resolves each `graphs` entry via the `"./path:export"` notation (compiled graph or `makeGraph` factory), and maps `env` / `store` / `checkpointer` / `http` onto Skein's wiring. Consumed by the CLI and the adapters.

## Reuse

Wraps `@langchain/langgraph-api`'s `./schema` graph parser rather than re-parsing `langgraph.json` by hand. Adds Skein-specific `skein.json` overrides and driver selection on top.

## Install

```bash
pnpm add @skein/config
```

## Learn more

- [Skein overview](../../docs/index.md)
- [Reuse-first architecture](../../docs/reuse.md)
- [Roadmap](../../docs/roadmap.md)

## License

[Apache-2.0](../../LICENSE)
