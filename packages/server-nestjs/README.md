# @skein-js/nestjs

> NestJS adapter for skein-js (planned).

Part of **[skein-js](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🗺️ Planned — after the Express adapter.

## What it does

A `SkeinModule.forRoot(config)` dynamic module exposing the Agent Protocol through Nest controllers.

## Reuse

Thin transport shim over [`@skein-js/core`](../core).

## Install

```bash
pnpm add @skein-js/nestjs
```

## Learn more

- [skein-js overview](../../docs/index.md)
- [Reuse-first architecture](../../docs/reuse.md)
- [Roadmap](../../docs/roadmap.md)

## License

[Apache-2.0](../../LICENSE)
