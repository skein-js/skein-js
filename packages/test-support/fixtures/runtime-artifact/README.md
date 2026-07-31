# `runtime-artifact` — a prebuilt `skein build` artifact, by hand

What `skein start` serves in production: a `langgraph.json` pointing at **compiled JS** graphs, a baked
`schemas.json`, and nothing else. Committed rather than generated so the runtime matrix
(`scripts/runtime-conformance.mjs`) can boot the same bytes under Node, Bun, and Deno.

Deliberately not produced by running `skein build` in CI. Bundling happens on the host under Node
whatever the target runtime is, so building per runtime would add a step that cannot differ between
them while making the job depend on vite, Docker, and network installs. The matrix exists to vary the
**serving** runtime; this holds everything else still.

Consequences worth knowing:

- `graphs/tokens.js` is plain JS. A `.ts` graph here would need the toolchain the artifact exists to
  prove is unnecessary — and `@langchain/langgraph-api`'s schema parser rejects plain JS anyway, which
  is why the schemas are baked rather than extracted.
- `schemas.json` is a **stub**, not real introspection output. The matrix asserts the schema endpoint
  answers, never that the schema is faithful; `bundle-project.test.ts` covers real extraction.
- The graph's shape is tunable from the environment (`MATRIX_FRAMES`, `MATRIX_FRAME_BYTES`,
  `MATRIX_FPS`) so one fixture serves both the correctness pass and the burst-retention check.
