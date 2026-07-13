# CLAUDE.md

> **[AGENTS.md](./AGENTS.md) is the canonical guide for this repo — read it first.** It holds
> the conventions, commands, package map, and definition of done. This file only adds
> Claude-specific pointers and must not duplicate it.

## Notes

- **This is an [Nx](https://nx.dev) monorepo (pnpm).** Drive all tasks through Nx targets —
  `nx build <project>`, `nx test <project>`, and prefer `nx affected -t build test typecheck`
  over running things by hand. Each package has a `project.json`. Full command list is in
  [AGENTS.md](./AGENTS.md#this-is-an-nx-monorepo-pnpm--use-nx).
- **Reuse first.** Before writing code, check [docs/reuse.md](./docs/reuse.md) — much of what
  Skein needs already exists in the MIT `@langchain/*` packages.
- **Style is codified**, not a matter of taste: [docs/code-practices.md](./docs/code-practices.md).
  Pragmatic functional style, named exports, kebab-case files; ESLint + Prettier are the
  source of truth — run `pnpm lint` / `pnpm format` rather than hand-formatting.
- **Testing:** Vitest + Testcontainers, shared conformance suite — [docs/testing.md](./docs/testing.md).

Everything else lives in [AGENTS.md](./AGENTS.md) and [`docs/`](./docs/index.md).
