# @skein-js/storage-postgres

> Postgres SkeinStore driver with pgvector semantic search, reusing PostgresSaver for checkpoints.

Part of **[skein-js](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — not yet implemented (Phase 1).

## What it does

Production `SkeinStore` over `pg`: owns assistants / threads / runs / store-item tables and migrations, and delegates graph checkpoints to `PostgresSaver`. Semantic store search uses pgvector, configured from `langgraph.json`'s `store.index`.

## Reuse

Reuses `@langchain/langgraph-checkpoint-postgres` (`PostgresSaver`) for graph checkpoints — skein-js only adds tables for protocol resources and a pgvector index for semantic store search.

## Install

```bash
pnpm add @skein-js/storage-postgres
```

## Learn more

- [skein-js overview](../../docs/index.md)
- [Reuse-first architecture](../../docs/reuse.md)
- [Roadmap](../../docs/roadmap.md)

## License

[Apache-2.0](../../LICENSE)
