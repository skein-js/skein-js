# @skein-js/config

> Loads an unchanged `langgraph.json`, validates it, and resolves each `path:export` graph, its schemas, and the optional custom-auth module.

Part of **[skein-js](https://github.com/mainawycliffe/skein)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — implemented: `langgraph.json` loading, `path:export` graph resolution, graph-schema introspection, env resolution, and custom-auth loading.

## What it does

`loadConfig()` reads an existing `langgraph.json` **unchanged**, validates it (Zod, unknown keys
preserved), and returns the parsed config plus a lazy graph registry — the boot-time entry point the
CLI, the runtime assembler, and the adapters all start from.

- **`graphs.load(id)`** resolves a `"./path:export"` entry to a runnable graph. It mirrors the
  LangGraph CLI's `resolveGraph` exactly — splits on the first colon, falls back to the `default`
  export, compiles an uncompiled graph builder, unwraps the `createAgent` wrapper, and returns a
  factory export **un-invoked** so per-run config still applies — so a project moves onto skein-js
  with **no code change**. Loads are cached; a failed load is not memoized, so a transient error can
  be retried.
- **`graphs.schemas(id)`** extracts the graph's input/output/state/config JSON schemas via static
  analysis (no module execution), for assistant introspection.
- **`resolveEnv()`** resolves the config's `env` (a `.env` path or an inline map) to a plain object —
  without touching `process.env`.
- **`loadAuthEngine()`** loads the optional `auth` block's `path:export` module (a LangGraph
  `@langchain/langgraph-sdk/auth` `Auth` instance) and adapts it to core's injectable `AuthEngine`.
- The parsed `env` / `store` / `checkpointer` / `http` / `auth` fields are exposed on `config` for
  the CLI and adapters to wire up.

## Install

```bash
pnpm add @skein-js/config
```

Peer dependencies: `@langchain/langgraph` and `@langchain/langgraph-sdk`.

## Usage

```ts
import { loadConfig, loadAuthEngine } from "@skein-js/config";

const { config, configDir, graphs } = await loadConfig({ cwd: projectDir });

const graph = await graphs.load("agent"); // a CompiledGraph or a per-config factory
const schemas = await graphs.schemas("agent"); // input/output/state/config JSON schemas
const auth = await loadAuthEngine(config.auth, { configDir }); // AuthEngine | undefined
```

To load TypeScript graphs (e.g. under `skein dev`), pass an `importModule` — a TS-capable importer
(the CLI injects a vite loader); it defaults to native dynamic `import()`.

## API

- **`loadConfig(options?): Promise<SkeinConfig>`** — `options`: `{ cwd?, configPath?, importModule? }`.
  Returns `{ config: LanggraphJson, configPath, configDir, graphs: GraphRegistry }`.
- **`GraphRegistry`** — `{ ids, spec(id), load(id), schemas(id) }`.
- **`parseLanggraphJson(raw): LanggraphJson`** + **`langgraphJsonSchema`** — validate/parse the config
  (passthrough: unknown keys preserved). Validated fields include `graphs`, `node_version`, `env`,
  `store.index`, `checkpointer`, `http`, `auth`, `dockerfile_lines`, `dependencies`.
- **`parseGraphSpec(spec, baseDir)`** / **`loadGraph(spec, importModule?)`** — the low-level
  `path:export` resolver (`GraphSpec`, `ResolvedGraph`, `CompiledGraphFactory`, `ModuleImporter`).
- **`parseEnvFile(text)`** / **`resolveEnv(config, configDir)`** — `.env` parsing + env resolution.
- **`loadAuthEngine(auth, { configDir, importModule? })`** — `AuthConfig` → `AuthEngine | undefined`.
- **`class SkeinConfigError`** — boot-time config error (distinct from core's edge `SkeinHttpError`).

## Reuse

Reuses `@langchain/langgraph-api`'s `./schema` parser (`getStaticGraphSchema`, `GraphSpec`,
`isAuthMatching`) for introspection and auth-filter semantics, and mirrors its (non-exported)
`resolveGraph` algorithm for `path:export` loading — rather than diverging from the CLI it replaces.

## Learn more

- [LangGraph CLI compatibility](../../docs/langgraph-cli-compat.md) · [Storage](../../docs/storage.md)
- [skein-js overview](../../docs/index.md) · [Reuse-first architecture](../../docs/reuse.md)

## License

[Apache-2.0](../../LICENSE)
