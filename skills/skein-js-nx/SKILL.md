---
name: skein-js-nx
description: Add or maintain a skein-js LangGraph.js server or local application inside an Nx workspace. Use when configuring Nx targets, task dependencies, caching, affected checks, or workspace imports.
license: Apache-2.0
---

# skein-js in an Nx workspace

Use the workspace's installed Nx version and conventions. This skill covers the Nx task wiring around a skein-js project; use the `skein-js` skill or [skein-js docs](https://skein-js.github.io/skein-js/using-skein) for graph and server behavior.

1. Inspect `nx.json`, package workspaces, existing projects, and the target app's scripts before adding configuration. Prefer an existing project or inferred targets when they already cover the requested task.
2. For a new skein-js app on Nx 23.2.1 through 23.x, install `@skein-js/nx` at the root (`pnpm add -Dw @skein-js/nx`) and run `pnpm exec nx g @skein-js/nx:application --directory=apps/my-agent`. Choose a new child directory and preview with `--dry-run` before writing. Select `--storage=sqlite` for local persistence. ESLint and Prettier default on; `--linting=false` opts out. Both integrated and package workspaces are supported. The generator inherits root tooling independently, extends the TypeScript base, preserves root lifecycle scripts and leaves installation manual. Existing applications can retain their targets. See [scaffolding](https://skein-js.github.io/skein-js/scaffolding#nx-and-other-monorepos).
3. Keep live `dev` and `start` hosts uncached. For a config-driven app, make `build` produce the skein artifact and cache only its build outputs, such as `.skein/build`. An embedded Electron, Tauri, or CLI app uses its own build outputs; preserve its host's packaging targets. Keep graph imports resolving through the workspace's existing package and TypeScript setup. Generated cached targets include `^default` dependency inputs; build, typecheck and test depend on `^build`. Preserve this wiring and the workspace dependency graph when importing libraries. For existing custom targets, use the workspace's appropriate dependency input and build ordering. Preserve runtime-state exclusions and verify that a library edit invalidates the app's cached build and checks.
4. Check the actual project and target names with `nx show projects` and `nx show project <name>`. Run the relevant targets through Nx, including a graph load and a run through the protocol service or SDK when practical. For CI, use Nx's affected task selection with the workspace's existing base/head convention.

Generated projects recommend Node 24 and support `^22.12.0 || ^24.0.0 || ^26.0.0`. Honor compatible `.nvmrc` or `.node-version` pins. Unsupported numeric pins must be resolved before generation; alias fallback is reported by the generator.

Configuration and tool dependency inheritance are independent. Declared root tools are reused; missing tools are added at the root for integrated layouts or to the application for package layouts. Preserve root configuration and its plugin dependencies, and keep installation manual. Both entrypoints format new files using inherited Prettier settings. Workspace-root CLI targets are rejected before writes, including with `--force`; use a new child directory through the Nx generator. See [workspace tooling](https://skein-js.github.io/skein-js/scaffolding).

The generated project runs `skein start` against its built artifact, not directly against TypeScript source. Preserve its build-to-start relationship and chosen storage: SQLite scaffolds need the SQLite pair and a writable file; Postgres/Redis configurations need their services. Set the target working directory so graph paths and the CLI's default `.skein/state.sqlite` resolve inside the intended app.

For a config-driven app started from its project root, use `skein start -c .skein/build/langgraph.json` and retain the generated storage flags. Bare `skein start` works when the working directory is the artifact directory. If the missing-schema error suggests an existing nested build, use its `-c` argument in the original start command, keeping all other options, including storage drivers and any custom `--sqlite-path`. Artifact selection stays explicit.

The live SQLite database, including its `-wal` and `-shm` companions, is runtime state. Keep it outside cached outputs and build inputs; caching all of `.skein/` would capture the database. An embedding host supplies its own absolute application-data path and owns backend startup and shutdown. See [local deployment](https://skein-js.github.io/skein-js/local-deployment), [scaffolding](https://skein-js.github.io/skein-js/scaffolding), and [Nx run tasks](https://nx.dev/docs/features/run-tasks).
