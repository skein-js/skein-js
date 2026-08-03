# `build-project` — a project for `skein build` to compile, in the shape that breaks

The subject of `scripts/build-image-smoke.mjs`: the one place CI runs a **real** `skein build` and
then builds the image it produces, so the whole chain — bundle → pinned `package.json` → the
Dockerfile's `npm install --omit=dev` → the graph compatibility probe — is exercised end to end.

Its sibling, `runtime-artifact/`, is a **pre-built** artifact committed by hand; it varies the serving
runtime and holds everything else still. This one is the opposite: plain project source, built for
real, on Node only.

The shape is deliberate. It reproduces
[issue #6](https://github.com/skein-js/skein-js/issues/6), where `skein build` externalized every
published package correctly but recorded none of them into the artifact's `package.json`, and the
image died on `ERR_MODULE_NOT_FOUND` inside its own probe:

- **`apps/app/src/graph.ts` imports `date-fns`.** A real published package that nothing else in the
  image installs — not `skein-js`, not `@langchain/langgraph`, not their transitive trees. A missing
  pin therefore fails the probe rather than being masked by a hoisted install, which is why simple
  projects (whose graph imports are all `@langchain/*`, pulled in under `@langchain/langgraph`)
  survived the bug for so long. `date-fns` is what the issue reporter actually hit.
- **`libs/lib` is reached through a `tsconfig.base.json` path alias**, so the build has to inline
  workspace source that no `node_modules` install could supply — the monorepo case `skein build`
  exists for.
- **`pnpm-workspace.yaml` sits at the fixture root** so vite's `searchForWorkspaceRoot` stops here
  instead of walking up into the skein repo.

`apps/app/package.json` declares `date-fns` at an exact version and nothing else. It is deliberately
**not** a workspace package — the root `pnpm install` never sees it — so `build-image-smoke.mjs`
installs it into the fixture itself before building. Declaring the dependency where it is actually
imported is what keeps it safe: a `pnpm dedupe`, a depcheck pass, or anyone pruning an unused entry
from a shared manifest cannot silently break this job. Nothing here is published or built by Nx.
