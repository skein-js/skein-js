# @skein-js/fastify

> Fastify adapter for skein-js — **planned, not yet implemented**.

Part of **[skein-js](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🗺️ Planned — after the Express adapter. This package is a placeholder: it is not
implemented, exports no adapter API, and is **not published** to npm yet.

## What it will do

A Fastify plugin that mounts the [`@skein-js/agent-protocol`](../agent-protocol) handler table and
streams SSE via the Fastify reply — a thin transport shim, exactly like
[`@skein-js/express`](../server-express), reusing the same framework-agnostic engine underneath.
Until then, use the **Express adapter**, which ships today.

When implemented it will require `fastify` (`>=4`) as a peer dependency.

## Learn more

- [`@skein-js/express`](../server-express) — the shipped adapter to use today
- [Roadmap](../../docs/roadmap.md) · [skein-js overview](../../docs/index.md)

## License

[Apache-2.0](../../LICENSE)
