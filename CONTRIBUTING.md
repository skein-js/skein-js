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
