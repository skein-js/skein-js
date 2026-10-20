---
name: skein-js
description: Build or adapt a TypeScript LangGraph.js project with skein-js for a server, desktop app, CLI, or daemon. Use for scaffolding, serving an existing langgraph.json, embedding graphs with memory, SQLite, or Postgres, or connecting Agent Protocol clients.
license: Apache-2.0
---

# Build with skein-js

skein-js hosts LangGraph.js graphs. LangGraph defines graph state, nodes, edges, tools, and execution; skein-js supplies the Agent Protocol engine, persistence, background work, and console. The same engine runs in a server or a local application. Use the existing LangGraph APIs and `@langchain/langgraph-sdk` client rather than inventing skein-specific graph or client abstractions.

## Choose the shortest supported path

- **New project:** Inspect workspace markers first, then use `npm create skein-js@latest <name>` in a new directory, or the Nx generator in an Nx workspace. Generated projects recommend Node 24, support `^22.12.0 || ^24.0.0`, and enable ESLint/Prettier by default (`--no-linting` opts out). Keep the keyless echo graph until the first server run succeeds. See [scaffolding](https://skein-js.github.io/skein-js/scaffolding).
- **Existing `langgraph.json`:** Keep the config and graph exports; use the skein CLI in place of the LangGraph CLI. Check [compatibility](https://skein-js.github.io/skein-js/langgraph-cli-compat) before changing any config field.
- **Graph compiled in an existing app:** Pick the adapter for the app's framework and pass either `{ config }` or assembled `{ deps }`. Mount the adapter at the intended URL and set the client's `apiUrl` to that mount root. See [using skein-js](https://skein-js.github.io/skein-js/using-skein) and [embedding](https://skein-js.github.io/skein-js/embedding).
- **Desktop app, CLI, or daemon with local persistence:** Scaffold with `npm create skein-js@latest <name> -- --storage sqlite`, or embed graphs through `embedSqliteGraphs` from `@skein-js/local`. Use the existing protocol service directly or an HTTP/SSE adapter with the existing SDK. See [local deployment](https://skein-js.github.io/skein-js/local-deployment).

SQLite is an explicit option for Node 22/24 with one process owning each database file. Install the upstream SQLite saver as documented, supply an absolute `sqlitePath` when embedding, and let the host start its worker or adapter and stop it before disposing storage. A desktop UI and a separate daemon can use the same protocol; keep database ownership in the backend process. The [Electron](https://github.com/skein-js/skein-js/tree/main/examples/desktop-electron), [Tauri](https://github.com/skein-js/skein-js/tree/main/examples/desktop-tauri), and [CLI](https://github.com/skein-js/skein-js/tree/main/examples/local-cli) examples show supported host integration and native packaging.

Applications choose models, tools, credentials, process lifetime, and recovery behavior. A local app can use a cloud provider or a local model. SQLite records abandoned attempts as failures without automatically replaying input or continuing checkpoints; live stream frames remain process-local. Recover the UI from persisted records and state/history APIs.

For a normal model and tool loop, prefer LangChain's `createAgent`; use a custom LangGraph `StateGraph` when the requested workflow needs explicit state or branching. For planning, files, and subagents, export a `createDeepAgent()` graph from the upstream `deepagents` package (support is experimental); give its `StoreBackend` a namespace built from `langgraph_auth_user_id`, use `stream_subgraphs` to stream subagents, and give async subagents an explicit `url`. See the [Deep Agents recipe](https://github.com/skein-js/skein-js/blob/main/docs/recipes/deep-agents.md). Consult the installed LangGraph version and [official LangGraph documentation](https://docs.langchain.com/oss/javascript/langgraph/overview) for graph APIs. When skein manages a served graph, let it inject the checkpointer and store; do not pass them to `.compile()` yourself. See [LangGraph essentials](https://skein-js.github.io/skein-js/langgraph-essentials).

## Complete the project

1. Inspect the user's package manager, framework, existing graph and config, and deployment needs. Preserve existing choices.
2. Implement the smallest graph and host wiring that meet the request. Use the scaffold or a matching [runnable example](https://github.com/skein-js/skein-js/tree/main/examples) as a starting point when useful.
3. Run the project's typecheck and tests, plus lint and format checks when those scripts exist. Apply inherited formatting before checking CLI-generated files. Start the host when practical, confirm the graph loads, and exercise one run through the protocol service, console, or SDK. For an interrupt workflow, exercise pause and resume; when local durability is claimed, reopen the SQLite file and verify persisted state. Report any check you could not run.
4. Choose durability for the host: [SQLite](https://skein-js.github.io/skein-js/local-deployment) for one local owner, or [Postgres and Redis](https://skein-js.github.io/skein-js/deploy) for a shared server. CLI SQLite selection requires `--store sqlite --queue sqlite`; memory remains the default for `skein dev`.

In a workspace, use a new child directory, preserve root configuration, and leave dependency installation at the root. Root tool declarations are reused independently of configuration inheritance; missing tool dependencies are added to the generated package. New files follow inherited Prettier settings. Workspace-root targets are rejected before writes, including with `--force`. See [workspace tooling](https://skein-js.github.io/skein-js/scaffolding).

For an Nx or Turborepo workspace, use the matching skein-js workspace skill if installed. Otherwise follow the workspace's existing task conventions and [monorepo guidance](https://skein-js.github.io/skein-js/scaffolding#nx-and-other-monorepos).
