---
name: skein-js-turborepo
description: Add or maintain a skein-js LangGraph.js agent project inside a Turborepo workspace. Use when configuring Turbo tasks, caching, package dependencies, or workspace imports for a skein-js app.
license: Apache-2.0
---

# skein-js in a Turborepo workspace

Use the workspace's package manager and installed Turbo version. This skill covers task wiring around a skein-js project; use the `skein-js` skill or [skein-js docs](https://skein-js.github.io/skein-js/using-skein) for graph and server behavior.

1. Inspect `turbo.json`, workspace package patterns, package names, and existing scripts. Integrate with the conventions already present rather than replacing the task graph.
2. For a new app, scaffold skein-js in the intended workspace directory and make sure the package manager includes it. Keep the generated `dev`, `build`, and `start` scripts unless the app already has equivalent ones. See [scaffolding](https://skein-js.github.io/skein-js/scaffolding#nx-and-other-monorepos).
3. Configure Turbo's `dev` task as persistent and uncached. If `build` is cached, include the skein build artifact in its outputs and account for workspace dependencies and build-time environment variables that affect it. Do not cache a live server or assume runtime credentials are build inputs. Follow the installed Turbo version's [task configuration](https://turborepo.com/docs/reference/configuration).
4. Run the app's tasks through Turbo using the actual package name or filter, then start its server and exercise one graph run through the console or Agent Protocol SDK when practical. Confirm that `start` reads the built artifact and that any required Postgres/Redis services are available.

Keep `langgraph.json` paths valid from the app package's working directory. A graph can import shared workspace packages through the workspace's existing package links and TypeScript configuration; see [LangGraph CLI compatibility](https://skein-js.github.io/skein-js/langgraph-cli-compat).
