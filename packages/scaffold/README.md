# @skein-js/scaffold (private)

Shared pure project builders, compiled templates, Node policy and workspace planning for
`create-skein-js` and `@skein-js/nx`. Bundled into both entrypoints; never published or required
from a consumer at runtime.

Edit `templates/`, then run `pnpm exec nx run scaffold:generate-templates`; generated TypeScript is
checked against its sources. Both entrypoints share Node policy, workspace planning, and default-on
ESLint and Prettier, with each root configuration inherited independently.

Tests cover all 96 provider/storage/package-manager/tooling combinations. The internal
`scripts/scaffold-cases.json` catalog also drives 30 installed consumers through test-support Nx
targets. See the [testing guide](../../docs/testing.md#scaffold-consumers)
for commands and coverage limits, and the [workspace limitations](https://skein-js.github.io/skein-js/scaffolding)
for integration cases that still need fixes and regression coverage.
