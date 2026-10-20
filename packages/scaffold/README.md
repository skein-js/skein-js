# @skein-js/scaffold (private)

Shared pure project builders, compiled templates, Node policy and workspace planning for
`create-skein-js` and `@skein-js/nx`. Bundled into both entrypoints; never published or required
from a consumer at runtime.

Edit `templates/`, then run `nx run scaffold:generate-templates`. Tests cover all 96 generation
combinations. Installed checks use `scripts/scaffold-cases.json` through test-support Nx targets.
