# AGENTS.md

Canonical guide for humans **and** AI coding agents working in this repo. If you only read
one file before contributing, read this one. (Claude Code: `CLAUDE.md` points here.)

## What skein-js is

A TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for
[LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a **drop-in replacement for
the LangGraph CLI** (`skein dev` ⇄ `langgraph dev`, unchanged `langgraph.json`). Think
"[aegra](https://github.com/aegra/aegra) for TypeScript."

## Read first

- [docs/index.md](./docs/index.md) — overview & architecture
- [docs/reuse.md](./docs/reuse.md) — **what we reuse from LangGraph OSS vs. rebuild**
- [docs/code-practices.md](./docs/code-practices.md) — codified conventions
- [docs/testing.md](./docs/testing.md) — testing strategy
- [docs/roadmap.md](./docs/roadmap.md) — milestones

## Golden rules

1. **Reuse first.** Before writing anything, check whether a `@langchain/*` package already
   does it ([docs/reuse.md](./docs/reuse.md)). The best code is the code we don't write.
2. **Pragmatic functional style.** Pure core, dependencies injected; thin classes only for
   stateful resources (pools/clients). Immutable by default. Validate at boundaries with Zod;
   throw typed errors at the edges.
3. **Simple & consistent.** Small functions, named exports, kebab-case files, one public
   surface per package (`src/index.ts`). Match the surrounding style. Let the linter/formatter
   settle style — don't hand-argue it.
4. **Green before commit — never commit red.** A pre-commit hook enforces this mechanically:
   [`.githooks/pre-commit`](.githooks/pre-commit), wired by `pnpm install` (`prepare` sets
   `core.hooksPath`), runs `nx format:check` + `nx affected -t lint typecheck test` (with `CI=true`
   so Vitest runs once; `examples/*` excluded — they need live services / local `.env`) for whatever
   your staged changes touch. Build and the Docker-backed integration tests run in
   [CI](.github/workflows/ci.yml) — run them locally too for anything substantial
   (`nx run-many -t build test-integration`). Keep docs current with any behavior/architecture change.
   [`/commit`](.claude/skills/commit/SKILL.md) does the full local run + docs check for you. Only
   bypass the hook (`git commit --no-verify`) in a genuine pinch, and go green before you push. Same
   bar as [Definition of done](#definition-of-done).

## This is an Nx monorepo (pnpm) — use Nx

**Always drive tasks through Nx**, not ad-hoc scripts. Nx gives caching, the affected-graph,
and consistent targets across packages. Every root `pnpm` script is a thin wrapper over an
Nx target — there are no bare `eslint`/`prettier`/`vitest` invocations.

- `build` / `typecheck` / `test-integration` are defined per project in `project.json`.
- `lint` is inferred by the **`@nx/eslint`** plugin from the root `eslint.config.mjs`.
- `test` is inferred by the **`@nx/vite`** plugin from each project's `vitest.config.ts`.
- Formatting is **Nx's built-in Prettier** (`nx format:write` / `nx format:check`).

```bash
pnpm install                      # bootstrap the workspace

# whole workspace (each is `nx run-many -t <target>`)
pnpm build
pnpm typecheck
pnpm lint                         # nx run-many -t lint   (@nx/eslint)
pnpm format                       # nx format:write       (Prettier via Nx)
pnpm test                         # nx run-many -t test   (@nx/vite, unit)
pnpm test:integration             # nx run-many -t test-integration (Testcontainers; needs Docker)

# a single project
nx build core                     # == nx run core:build
nx test storage-postgres
nx test-integration storage-postgres

# only what your change affects (prefer this in CI + locally)
pnpm affected                     # nx affected -t lint test typecheck build
nx graph                          # visualize the project graph
```

### Tests

Vitest via a workspace config; Testcontainers for real Postgres/Redis. See
[docs/testing.md](./docs/testing.md).

```bash
pnpm test                         # fast unit + conformance (memory), no Docker
pnpm test:integration             # *.integration.test.ts — needs Docker
pnpm test:coverage
nx affected -t test               # affected projects only
```

### Adding a package

Match the existing shape exactly (keep it boring and consistent):
`packages/<dir>/{package.json, project.json, tsconfig.json, vitest.config.ts, README.md, src/index.ts}`,
`"@skein-js/<name>"`, publishable metadata (`publishConfig.access: public`, `repository.directory`),
and a path alias in [`tsconfig.base.json`](./tsconfig.base.json). `project.json` defines only
`build` + `typecheck` (+ `test-integration` if it touches Postgres/Redis); `lint` and `test`
are **inferred** by the Nx plugins from `eslint.config.mjs` and `vitest.config.ts`.
**Scaffold with the Nx CLI, never by hand:** `npx nx g @nx/js:lib <name> --directory=packages/<dir>
--importPath=@skein-js/<name>`, then align the generated files to the `@skein-js/core` template. Do
not create a package tree file-by-file.

## Releasing

Releases are cut with **`nx release`** (configured in [`nx.json`](./nx.json) as a _fixed_ group — every
`packages/*` shares one version and one `v{version}` tag) and **published by CI, not locally**:

```bash
pnpm release:dry-run 0.3.0    # preview everything; changes nothing
pnpm release 0.3.0            # or: patch | minor | major
```

`pnpm release <specifier>` runs a build + typecheck gate, bumps every package to the new version, writes
`CHANGELOG.md`, commits, tags `v<version>`, pushes, and **creates a GitHub Release**. It does not publish
(the script bakes in `--skip-publish`). Publishing to npm is triggered by that release:
[`.github/workflows/release.yml`](.github/workflows/release.yml) runs on `release: published` and
publishes each changed, non-private package with provenance via npm OIDC trusted publishing.

Prerequisites: the git remote must point at `mainawycliffe/skein-js` (Nx derives the release repo from
`origin`), and `gh` must be authenticated (or `GITHUB_TOKEN` set) for the GitHub Release step.

## Package map

| Package                                                        | Role                                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@skein-js/core`                                               | The shared contract: Agent Protocol wire types + `SkeinStore`/queue/bus interfaces + edge error               |
| `@skein-js/agent-protocol`                                     | Framework-agnostic Agent Protocol engine — run engine, handler table, SSE (the heart); publishable on its own |
| `@skein-js/config`                                             | `langgraph.json` parser + graph loader (wraps `@langchain/langgraph-api`)                                     |
| `@skein-js/express` · `@skein-js/fastify` · `@skein-js/nestjs` | Framework adapters (Express first)                                                                            |
| `@skein-js/storage-memory`                                     | In-memory `SkeinStore` + queue (dev/tests)                                                                    |
| `@skein-js/storage-postgres`                                   | Postgres `SkeinStore` + pgvector; reuses `PostgresSaver`                                                      |
| `@skein-js/redis`                                              | Run **queue** + cross-instance pub/sub (not a checkpointer)                                                   |
| `@skein-js/runtime`                                            | Assembles production `ProtocolDeps` (memory/Postgres/Redis) from `langgraph.json` for the CLI                 |
| `skein-js` (CLI)                                               | Drop-in `dev` / `up` / `build` / `dockerfile`                                                                 |
| `@skein-js/test-support`                                       | _(private)_ Testcontainers helpers + `SkeinStore` conformance suite                                           |

Examples live in `examples/`: `chat-app` (flagship — research assistant + Next.js/shadcn UI),
`migrated-langgraph` (drop-in proof), `gemini-chat` (model-backed e2e), `express-basic`
(zero-setup), `react-usestream` (`useStream` harness).

## Conventions (enforced)

- **TypeScript strict**, ESM only, **named exports only** in `packages/*` (Next.js example excepted).
- **Filenames** `kebab-case.ts`; types `PascalCase`, values `camelCase`.
- **Names reveal purpose** — a reader knows what a symbol does from its name alone. No vague names
  (`data`, `info`, `util`, `handle`, `manager`, `process`, `doIt`) and no unexplained abbreviations.
  Functions read verb-first (`startRun`, `resolveGraph`, `mirrorThreadState`); values are nouns
  (`activeRun`, `graphResolver`). Prefer a longer honest name over a short opaque one.
- **Layout by feature** (`runs/`, `threads/`, `store/`), not by kind.
- **Zod** at boundaries; typed error classes at edges.
- **[Conventional Commits](https://www.conventionalcommits.org)** (`feat(core): …`), small focused PRs.

## Definition of done

- [ ] `pnpm lint`, `pnpm format:check`, `pnpm typecheck` clean.
- [ ] `pnpm test` green; container tests added for new DB/queue behavior (`*.integration.test.ts`).
- [ ] New storage drivers pass the shared `SkeinStore` conformance suite.
- [ ] Reused an existing `@langchain/*` capability instead of reinventing where one exists.
- [ ] Docs updated if behavior/architecture changed.
