---
name: skein-js-nx
description: Add or maintain a skein-js LangGraph.js server or local application inside an Nx workspace. Use when configuring Nx targets, task dependencies, caching, affected checks, or workspace imports.
license: Apache-2.0
---

# skein-js in an Nx workspace

Use the workspace's installed Nx version and conventions. This skill covers the Nx task wiring around a skein-js project; use the `skein-js` skill or [skein-js docs](https://skein-js.github.io/skein-js/using-skein) for graph and server behavior.

1. Inspect `nx.json`, package workspaces, existing projects, and the target app's scripts before adding configuration. Prefer an existing project or inferred targets when they already cover the requested task.
2. For a new skein-js app, scaffold it in the chosen workspace directory, then integrate it with Nx. Select `--storage sqlite` when local persistence is requested; preserve existing defaults otherwise. Follow [skein-js's Nx example](https://skein-js.github.io/skein-js/scaffolding#nx-and-other-monorepos) and the installed Nx version's [project configuration](https://nx.dev/docs/reference/project-configuration). Do not create a skein-specific Nx plugin for ordinary task wiring.
3. Keep live `dev` and `start` hosts uncached. For a config-driven app, make `build` produce the skein artifact and cache only its build outputs, such as `.skein/build`. An embedded Electron, Tauri, or CLI app uses its own build outputs; preserve its host's packaging targets. Keep graph imports resolving through the workspace's existing package and TypeScript setup.
4. Check the actual project and target names with `nx show projects` and `nx show project <name>`. Run the relevant targets through Nx, including a graph load and a run through the protocol service or SDK when practical. For CI, use Nx's affected task selection with the workspace's existing base/head convention.

The generated project runs `skein start` against its built artifact, not directly against TypeScript source. Preserve its build-to-start relationship and chosen storage: SQLite scaffolds need the SQLite pair and a writable file; Postgres/Redis configurations need their services. Set the target working directory so graph paths and the CLI's default `.skein/state.sqlite` resolve inside the intended app.

The live SQLite database, including its `-wal` and `-shm` companions, is runtime state. Keep it outside cached outputs and build inputs; caching all of `.skein/` would capture the database. An embedding host supplies its own absolute application-data path and owns backend startup and shutdown. See [local deployment](https://skein-js.github.io/skein-js/local-deployment), [scaffolding](https://skein-js.github.io/skein-js/scaffolding), and [Nx run tasks](https://nx.dev/docs/features/run-tasks).
