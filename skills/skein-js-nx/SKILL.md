---
name: skein-js-nx
description: Add or maintain a skein-js LangGraph.js agent project inside an Nx workspace. Use when configuring Nx targets, task dependencies, caching, affected checks, or workspace imports for a skein-js app.
license: Apache-2.0
---

# skein-js in an Nx workspace

Use the workspace's installed Nx version and conventions. This skill covers the Nx task wiring around a skein-js project; use the `skein-js` skill or [skein-js docs](https://skein-js.github.io/skein-js/using-skein) for graph and server behavior.

1. Inspect `nx.json`, package workspaces, existing projects, and the target app's scripts before adding configuration. Prefer an existing project or inferred targets when they already cover the requested task.
2. For a new skein-js app, scaffold it in the chosen workspace directory, then integrate it with Nx. Follow [skein-js's Nx example](https://skein-js.github.io/skein-js/scaffolding#nx-and-other-monorepos) and the installed Nx version's [project configuration](https://nx.dev/docs/reference/project-configuration). Do not create a skein-specific Nx plugin for ordinary task wiring.
3. Ensure `dev` and `start` are long-running, uncached targets. Make `build` produce the skein artifact; configure its outputs if the workspace caches build results. Keep graph imports resolving through the workspace's existing package and TypeScript setup.
4. Check the actual project and target names with `nx show projects` and `nx show project <name>`. Run the relevant targets through Nx, including a graph load and an Agent Protocol request when practical. For CI, use Nx's affected task selection with the workspace's existing base/head convention.

The generated project runs `skein start` against its built artifact, not directly against TypeScript source. Preserve its build-to-start relationship and required Postgres/Redis services. See [scaffolding](https://skein-js.github.io/skein-js/scaffolding) and [Nx run tasks](https://nx.dev/docs/features/run-tasks).
