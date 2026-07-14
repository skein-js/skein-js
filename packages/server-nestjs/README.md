# @skein-js/nestjs

> NestJS adapter for skein-js — **planned, not yet implemented**.

Part of **[skein-js](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🗺️ Planned — after the Express adapter. This package is a placeholder: it is not
implemented, exports no adapter API, and is **not published** to npm yet.

## What it will do

A `SkeinModule.forRoot(config)` dynamic module exposing the Agent Protocol through Nest controllers —
a thin transport shim over the [`@skein-js/agent-protocol`](../agent-protocol) handler table, reusing
the same framework-agnostic engine as [`@skein-js/express`](../server-express). Until then, use the
**Express adapter**, which ships today.

When implemented it will require `@nestjs/common` and `@nestjs/core` (`>=10`) as peer dependencies.

## Learn more

- [`@skein-js/express`](../server-express) — the shipped adapter to use today
- [Roadmap](../../docs/roadmap.md) · [skein-js overview](../../docs/index.md)

## License

[Apache-2.0](../../LICENSE)
