---
name: skein-js
description: Build or adapt a TypeScript LangGraph.js agent project with skein-js. Use for scaffolding an agent server, serving an existing langgraph.json, embedding a graph in an app, or wiring Agent Protocol clients to skein-js.
license: Apache-2.0
---

# Build with skein-js

skein-js hosts LangGraph.js graphs. LangGraph defines graph state, nodes, edges, tools, and execution; skein-js supplies the Agent Protocol server, persistence, background work, and console. Use the existing LangGraph APIs and `@langchain/langgraph-sdk` client rather than inventing skein-specific graph or client abstractions.

## Choose the shortest supported path

- **New project:** Use `npm create skein-js@latest <name>` and adapt the generated project. Keep its keyless echo graph until the first server run succeeds. See [scaffolding](https://skein-js.github.io/skein-js/scaffolding).
- **Existing `langgraph.json`:** Keep the config and graph exports; use the skein CLI in place of the LangGraph CLI. Check [compatibility](https://skein-js.github.io/skein-js/langgraph-cli-compat) before changing any config field.
- **Graph compiled in an existing app:** Pick the adapter for the app's framework and pass either `{ config }` or assembled `{ deps }`. Mount the adapter at the intended URL and set the client's `apiUrl` to that mount root. See [using skein-js](https://skein-js.github.io/skein-js/using-skein) and [embedding](https://skein-js.github.io/skein-js/embedding).

For a normal model and tool loop, prefer LangChain's `createAgent`; use a custom LangGraph `StateGraph` when the requested workflow needs explicit state or branching. Consult the installed LangGraph version and [official LangGraph documentation](https://docs.langchain.com/oss/javascript/langgraph/overview) for graph APIs. When skein manages a served graph, let it inject the checkpointer and store; do not pass them to `.compile()` yourself. See [LangGraph essentials](https://skein-js.github.io/skein-js/langgraph-essentials).

## Complete the project

1. Inspect the user's package manager, framework, existing graph and config, and deployment needs. Preserve existing choices.
2. Implement the smallest graph and server wiring that meet the request. Use the scaffold or a matching [runnable example](https://github.com/skein-js/skein-js/tree/main/examples) as a starting point when useful.
3. Run the project's typecheck and tests. Start the server when practical, confirm the graph loads, and exercise one run through the console or Agent Protocol SDK. For an interrupt workflow, exercise pause and resume. Report any check you could not run.
4. If durable deployment is requested, follow [production guidance](https://skein-js.github.io/skein-js/deploy) for Postgres and Redis. Do not present in-memory development state as a production setup.

For an Nx or Turborepo workspace, use the matching skein-js workspace skill if installed. Otherwise follow the workspace's existing task conventions and [monorepo guidance](https://skein-js.github.io/skein-js/scaffolding#nx-and-other-monorepos).
