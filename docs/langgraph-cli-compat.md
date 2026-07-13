# LangGraph CLI compatibility

Skein's headline goal is to be a **drop-in replacement for the LangGraph CLI**. That means
two things: read the same `langgraph.json`, and mirror the same command surface.

## Command mapping

| LangGraph CLI | Skein | Behavior |
| --- | --- | --- |
| `langgraph dev` | `skein dev` | In-process dev server, hot reload, **no Docker**. Local state. |
| `langgraph up` | `skein up` | Docker Compose stack (app + **Postgres + Redis**). |
| `langgraph build` | `skein build` | Build a deployable Docker image from the config. |
| `langgraph dockerfile` | `skein dockerfile` | Emit a standalone Dockerfile from the config. |
| `langgraph deploy` | — | Out of scope (hosted-platform push). |

Shared flags where sensible: `--port`, `--host`, `--no-reload`, `--config`.

References:
- LangGraph CLI docs — <https://docs.langchain.com/langsmith/cli>
- `@langchain/langgraph-cli` (npm) — <https://www.npmjs.com/package/@langchain/langgraph-cli>

## `langgraph.json` — fields we honor

Skein parses an existing `langgraph.json` **unchanged**. A `skein.json` may extend/override
it but is never required.

```jsonc
{
  // REQUIRED: map of graph id -> "path:export"
  "graphs": {
    "agent": "./src/agent.ts:graph",        // exported compiled graph instance
    "chat":  "./src/chat.ts:makeGraph"       // or a factory function
  },

  // JS/Node runtime pin (20 | 22 | 24)
  "node_version": "20",

  // .env path OR inline map
  "env": ".env",

  // long-term memory store; semantic search config drives our pgvector index
  "store": {
    "index": { "embed": "openai:text-embedding-3-small", "dims": 1536, "fields": ["$"] }
  },

  // checkpointer backend; "default" == Postgres (via PostgresSaver)
  "checkpointer": { "type": "default" },

  // server customization
  "http": {
    "cors": { "allow_origins": ["*"] },
    "disable_assistants": false,
    "disable_threads": false
    // custom user routes may be attached here in a later iteration
  },

  // extra Dockerfile lines appended after the base image
  "dockerfile_lines": []
}
```

### How each field maps into Skein

| `langgraph.json` field | Skein wiring |
| --- | --- |
| `graphs` | [`@skein/config`](./storage.md) resolves each `path:export`, loading a compiled graph or `makeGraph` factory. Drives `/agents` introspection + run execution. |
| `node_version` | Used by `skein build` / `skein dockerfile` base image selection. |
| `env` | Loaded into `process.env` at boot (dev) / baked into the image (build). |
| `store` | `store.index.{embed,dims,fields}` configures pgvector semantic search on the Postgres driver — see [storage.md](./storage.md). |
| `checkpointer` | `"default"` → `PostgresSaver`; dev falls back to an in-memory `MemorySaver`. |
| `http` | CORS + `disable_*` route flags applied by the framework adapter. |
| `dockerfile_lines` | Appended by `skein dockerfile` / `skein build`. |

## Graph loading (`path:export` notation)

`@skein/config` resolves entries exactly like the LangGraph CLI:

- `"./src/agent.ts:graph"` — imports the module and reads the `graph` export, which must be
  a `CompiledStateGraph`.
- `"./src/agent.ts:makeGraph"` — reads a factory export and calls it (optionally with
  config) to obtain a `CompiledStateGraph`.

This is the same contract LangGraph.js users already write against, so **no code changes
are required** to move a project onto Skein.

## `dev` vs `up`

- **`skein dev`** — single Node process, in-memory (or file-backed) state, hot reload on
  source change. No Docker. Fast feedback, the exact `langgraph dev` niche.
- **`skein up`** — Docker Compose bringing up the app plus Postgres (checkpoints + protocol
  resources + pgvector) and Redis (queue + cross-instance streaming). Mirrors production —
  see [runs-and-redis.md](./runs-and-redis.md).
