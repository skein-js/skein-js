# Dependency advisory audit — 20 October 2026

The complete pnpm workspace, including examples and development tools, was scanned against npm's
advisory service with the maintainer's approval. The initial report contained 186 vulnerability
occurrences (7 critical, 85 high, 84 moderate, 10 low), covering 133 distinct advisories in 40 packages.

## Remediation and compatibility

Patched versions are resolved in `pnpm-lock.yaml`. Root `pnpm.overrides` set security floors for
transitive dependencies whose parents still select vulnerable versions. These are workspace install
settings; they do not change published exports, function signatures, Node engine requirements, or
the adapters' public peer ranges.

- Nx and its plugins move together from 23.0.2 to 23.2.1; Vitest and coverage move together from
  4.1.9 to 4.1.11. TypeScript remains on 5.9.3. The Nx migrations were reviewed and run; changes
  intended for a TypeScript 6 migration were discarded, and the workspace already uses ESLint 9's
  flat configuration and React 19.
- Next.js examples and adapter test dependencies use 15.5.28, retaining Next.js 15. Fastify examples
  and adapter tests use 5.12.7, retaining Fastify 5. Adapter peer ranges remain unchanged.
- Private test and benchmark tooling uses Testcontainers 11.14.0, removing the old Undici 5 tree.
  Dockerode 4's UUID dependency resolves to 11.1.1; Dockerode uses its unchanged `v4` API.
- Private Electron packaging uses `@electron/packager` 20.3.0, which reuses Electron's maintained
  extraction package and downloader instead of the vulnerable `extract-zip`/`sprintf-js` tree.
  Its Node requirement remains the same as the previous packager (22.12 or newer).
- VitePress 1 remains in use. Its Vite dependency and Vue plugin peer resolve to Vite 6.4.4;
  workspace Vite 8 remains separate. Esbuild resolves to 0.28.2. The documentation build explicitly
  retains its previous native destructuring output for Safari 14, rather than requesting an
  unsupported lowering transform from the newer esbuild.
- Mermaid reuses KaTeX 0.18, Next.js reuses Sharp 0.35.5, and CSS tooling reuses
  `postcss-selector-parser` 7.1.6. These narrowly scoped tool dependencies require build validation;
  they add no Skein API.

## Braces: local patch, advisory still reported

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) affects `braces` 3.0.3 and
has no published patched release. It is reachable through glob dependencies, including Deep Agents'
`fast-glob` dependency; it must not be dismissed as only development tooling.

`patches/braces@3.0.3.patch` retains upstream parsing, compilation, expansion, and stringification.
It adds a maximum AST depth of 256 and rejects excessive brace or parenthesis nesting with a
`SyntaxError` before recursive traversal can exhaust the stack. Direct AST inputs receive the same
guard. Ordinary alternatives, ranges, nested groups, escaped delimiters, quoted text, and character
classes retain upstream behavior. Excessively nested patterns now fail with a bounded input error.
The regression suite is `packages/test-support/src/dependency-security.test.ts`.

Both full and production advisory scans still report this one high-severity advisory, because npm
checks the published package version and cannot recognize this local patch. No advisory is ignored
or suppressed. Replace the patch with a verified upstream fix when one is published.

The patch applies to installs of **this workspace** using its root pnpm configuration and lockfile.
Root overrides and patches are not inherited by applications installing published Skein packages
or Deep Agents independently. Those applications must audit their own lockfiles and apply the
patch in their own package-manager configuration until upstream publishes a fix. In particular,
reinstalling an exported application artifact with npm does not preserve this workspace's patch.

## Validation

- Nx lint, typecheck, unit tests, and build passed for all 27 library/tooling projects.
- All 14 offline Deep Agents tests passed, including authentication and async subagent behavior.
- All 9 Braces patch regressions passed, including direct AST inputs and ordinary glob behavior.
- All 492 Docker integration tests passed: Postgres (247), Redis (24), and runtime (221).
- The packaged Electron smoke test passed on macOS arm64, including native SQLite, Agent Protocol
  execution, and launching the application produced by Packager 20.
- The documentation build, Nx formatting check, and frozen offline pnpm install passed. The LLM
  documentation bundle was regenerated.
- Exports, Node engine requirements, and peer contracts were compared against the original
  manifests for all 23 published packages and remain unchanged.

## Reproduction

Run each scan once from the repository root through the docs project, passing an explicit project
so `nx exec` does not repeat it across the workspace:

```bash
pnpm nx exec -p docs -- pnpm -C "$PWD" audit --json
pnpm nx exec -p docs -- pnpm -C "$PWD" audit --prod --json
```

Keep `patches/` with `package.json` and `pnpm-lock.yaml` when installing the workspace. A frozen
install must apply the recorded patch. Do not use `audit --fix` blindly: its proposed major updates
and unavailable fixes need compatibility review.
