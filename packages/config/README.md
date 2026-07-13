# @skein-js/config

> langgraph.json parser and graph loader (path:export) for skein-js.

Part of **[skein-js](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — Phase 1. Implemented: `langgraph.json` loading + `path:export` graph resolution + graph-schema introspection.

## What it does

`loadConfig()` reads an existing `langgraph.json` **unchanged**, validates it (Zod, unknown keys preserved), and returns the parsed config plus a lazy graph registry:

- **`graphs.load(id)`** resolves a `"./path:export"` entry to a runnable graph. It mirrors the LangGraph CLI's `resolveGraph` exactly — splits on the first colon, falls back to the `default` export, compiles an uncompiled `StateGraph`, unwraps the `createAgent` wrapper, and returns a factory export un-invoked so per-run config still applies — so a project moves onto skein-js with **no code change**. Loads are cached; a failed load is not memoized, so a transient error can be retried.
- **`graphs.schemas(id)`** extracts the graph's input/output/state/config JSON schemas (for assistant introspection).
- The parsed `env` / `store` / `checkpointer` / `http` fields are exposed on `config` for the CLI and adapters to wire up.

skein-js-specific `skein.json` overrides and driver selection are planned on top.

## Usage

```ts
import { loadConfig } from "@skein-js/config";

const { config, graphs } = await loadConfig({ cwd: projectDir });
const graph = await graphs.load("agent"); // CompiledGraph or a per-config factory
```

## Reuse

Reuses `@langchain/langgraph-api`'s `./schema` parser (`getStaticGraphSchema`, `GraphSpec`) for introspection and mirrors its (non-exported) `resolveGraph` algorithm for `path:export` loading, rather than diverging from the CLI it replaces.

## Install

```bash
pnpm add @skein-js/config
```

## Learn more

- [skein-js overview](../../docs/index.md)
- [Reuse-first architecture](../../docs/reuse.md)
- [Roadmap](../../docs/roadmap.md)

## License

[Apache-2.0](../../LICENSE)
