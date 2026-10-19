---
name: skein-js-turborepo
description: Add or maintain a skein-js LangGraph.js server or local application inside a Turborepo workspace. Use when configuring Turbo tasks, caching, package dependencies, or workspace imports.
license: Apache-2.0
---

# skein-js in a Turborepo workspace

Use the workspace's package manager and installed Turbo version. This skill covers task wiring around a skein-js project; use the `skein-js` skill or [skein-js docs](https://skein-js.github.io/skein-js/using-skein) for graph and server behavior.

1. Inspect `turbo.json`, workspace package patterns, package names, and existing scripts. Integrate with the conventions already present rather than replacing the task graph.
2. For a new app, scaffold skein-js in the intended workspace directory and make sure the package manager includes it. Select `--storage sqlite` when local persistence is requested; preserve existing defaults otherwise. Keep the generated `dev`, `build`, and `start` scripts unless the app already has equivalent ones. See [scaffolding](https://skein-js.github.io/skein-js/scaffolding#nx-and-other-monorepos).
3. Configure long-running `dev` and `start` hosts as persistent and uncached. If `build` is cached, include the config-driven app's skein artifact or the embedding app's own build outputs, accounting for workspace dependencies and build-time environment variables that affect them. A one-shot CLI task does not need to be persistent. Do not cache a live host or assume runtime credentials are build inputs. Follow the installed Turbo version's [task configuration](https://turborepo.com/docs/reference/configuration).
4. Run the app's tasks through Turbo using the actual package name or filter, then start its host and exercise one graph run through the protocol service, console, or SDK when practical. Confirm that config-driven `start` reads the built artifact and that the chosen storage is available: a writable SQLite file for the local pair, or the configured Postgres/Redis services.

Keep `langgraph.json` paths valid from the app package's working directory. A graph can import shared workspace packages through the workspace's existing package links and TypeScript configuration; see [LangGraph CLI compatibility](https://skein-js.github.io/skein-js/langgraph-cli-compat).

Cache the build artifact, such as `.skein/build/**`, rather than all of `.skein/**`. Exclude the live SQLite database and its `-wal`/`-shm` companions from build inputs and outputs. An embedding host supplies an absolute application-data path and owns backend startup and shutdown; use the existing Agent Protocol for a separate UI and daemon. See [local deployment](https://skein-js.github.io/skein-js/local-deployment) for lifecycle and packaged host examples.
