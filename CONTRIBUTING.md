# Contributing to skein-js

Thanks for helping make skein-js better! Whether you're reporting a bug, suggesting a feature, or
sending a pull request, you're very welcome here.

> **Looking for how to _use_ skein-js?** See the [README](./README.md) and [docs/](./docs/index.md).
> This file is for people who want to change skein-js itself.

## Report a bug or request a feature

The fastest way to help is to [**open an issue**](https://github.com/skein-js/skein-js/issues).

A great bug report includes:

- **What you did** — ideally a minimal `langgraph.json` + graph, or a snippet.
- **What you expected** vs. **what happened** (error text, stack traces, HTTP status).
- **Versions** — the `skein-js` / `@skein-js/*` version, Node version, and OS.
- **How you ran it** — `skein dev`, `skein up`, or an embedded server; which `--store` / `--queue`.

Because the `skein` CLI aims to be a **drop-in for the LangGraph CLI**, one of the most valuable reports is
"this works under `langgraph dev` but not under `skein dev`" (or vice-versa) — a compatibility gap.
Please call that out explicitly if you hit one.

## Open a pull request

1. **Fork and branch** off `main`.
2. **Make focused changes** — small PRs are easier to review and land faster.
3. **Follow the conventions** and run the checks below before pushing.
4. **Use [Conventional Commits](https://www.conventionalcommits.org)** for your commit messages
   (e.g. `feat(express): …`, `fix(storage-postgres): …`, `docs: …`).
5. **Open the PR** against `main` and describe what changed and why.

### Before you push

```bash
pnpm install
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
```

New DB/queue behavior needs container-backed tests (`*.integration.test.ts`), and new storage
drivers must pass the shared `SkeinStore` conformance suite. See the deep guides below.

## Developing the console

The UI is a static Vite + React SPA (Tailwind, Radix dialogs, and system-aware light/dark themes), built by the `console-ui` Nx project. `nx serve console-ui` is the HMR dev loop.

`nx build console` then chains: build the SPA → compile its files into `src/assets.generated.ts` as
string constants → bundle. That last step is why the package can be a _library_: skein forbids reading
package-relative files at runtime, because bundlers rewrite `import.meta.url` to the output location
(see [bundling guide](./docs/bundling.md)). `@skein-js/storage-postgres` solved the same problem for its SQL;
the console does it for HTML, JS and CSS. A test pins the total size so the CLI's install cost cannot
drift upward unnoticed.

Run `nx run console-ui:test-browser` for real-HTTP deterministic graph scenarios, operation flows,
and responsive light/dark screenshots. It runs in CI alongside the unit tests. The asset test retains
a **1 MiB** uncompressed ceiling; the published package still has zero runtime dependencies.

### Console implementation notes

The UI is the `console-ui` Nx project in [`packages/console/ui/`](./packages/console/ui):

```bash
nx serve console-ui     # Vite dev server with HMR (point it at a running skein via ?baseUrl=)
nx build console        # build the SPA → compile assets in → bundle the package
nx test console         # resolver contract + 1 MiB asset budget
nx run console-ui:test-browser # real HTTP graphs, resource actions, responsive layouts
```

`src/assets.generated.ts` is generated, not committed. `build`, `typecheck` and `test` all depend on the
`generate-assets` target, so it cannot go stale.

The console is a **client** and holds no server-side state. It uses the Agent Protocol through the
official LangGraph SDK, plus two narrow skein operator endpoints for sanitized channel inventory and
run-delivery tracking. The Channels tab is read-only; code and `langgraph.json` stay the source of
truth. Delivery destinations are redacted before rendering, and replay requires confirmation.

The window-filling shell keeps navigation fixed and resource scrolling inside the main pane.
Playground docks its composer below scrolling conversation output and interrupt requests.
The sidebar groups Build, Inspect, and Operate workflows. Playground leads with a conversation or
schema-based JSON input, a visible execution summary, and Activity/Graph/State inspection. Assistant
versions, thread copy/pruning/retention, store creation/expiry, advanced runs, and schedules use the
existing SDK API. Failed drafts remain editable; observers never cancel execution when closed.

Playground resumes the last workspace in this tab; **New thread** starts fresh without creating a
resource until submission. **Recent threads** provides paged conversation discovery, and thread rows
and details offer **Open in Playground**. Assistant details can open a fresh Playground with that
configuration selected. Leaving Playground keeps active runs executing; **Stop run** cancels them.

A connection-scoped Zustand store keeps separate Chat/JSON drafts, input modes, and navigation
positions in memory, with versioned `sessionStorage` retention through reloads for the tab's lifetime.
Connection/API-key changes invalidate that workspace. Browser-storage failures fall back to memory
with a visible notice. Fetched transcripts, resources and SSE frames remain in the existing server
read/observation hooks. Inspection tabs use hash queries, and return links restore list context.

Passive store inspection requests `refreshTtl: false`. Unsupported custom adapters require an
explicit normal-read choice. Per-run timeout input is enabled only when `/info.flags.per_run_timeout`
is `true`. Delayed/keyed runs use background submission followed by observation; ambiguous failures
and failed batches are never automatically resubmitted. A batch may have partially created runs.

## Publishing the scaffolder

Publishing runs through `.github/workflows/release.yml` after the reusable CI gate. Before the first
release containing `@skein-js/nx`, maintainers must verify that the workflow's optional `NPM_TOKEN`
bootstrap credential is configured and authorized to create that package. Passing consumer tests
does not verify registry permissions.

After the package exists, configure its npm trusted publisher for repository `skein-js/skein-js`
and workflow `release.yml`, allowing direct `npm publish` as used by the workflow. Remove the
bootstrap token once every published package has a working trusted publisher. See npm's
[trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## Maintaining adoption documentation

Follow [the documentation rule](./AGENTS.md#documentation-teach-adoption-and-use). The
[November 2026 inventory](./docs/audits/documentation-adoption-2026-11-02.md) records which pages
needed adoption edits and why. Keep public guide steps, reference contracts, sidebar links, and
`llms.txt` aligned, and regenerate the LLM bundle after user-facing changes.

## The deep contributor guide

[**`AGENTS.md`**](./AGENTS.md) is the canonical, detailed guide for working in this repo — it's
written for both humans and AI coding agents and covers:

- The architecture and the **reuse-first** philosophy ([docs/reuse.md](./docs/reuse.md)).
- How this **Nx monorepo** is driven (`nx` targets, the affected graph, adding a package).
- [Coding conventions](./docs/code-practices.md) (ESM, named exports, kebab-case, Zod at boundaries).
- The [testing strategy](./docs/testing.md) (unit → Testcontainers → cross-driver conformance).
- The [roadmap](./docs/roadmap.md) and how [releases](./AGENTS.md#releasing) are cut.

Please read it before making non-trivial changes.

## Code of conduct

Be kind and constructive. We want skein-js to be a friendly place to contribute.

## License

By contributing, you agree that your contributions will be licensed under the project's
[Apache-2.0](./LICENSE) license.
