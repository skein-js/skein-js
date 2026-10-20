# @skein-js/nx

Generate a skein-js LangGraph application in Nx 23.2.1 through 23.x.

```bash
pnpm add -Dw @skein-js/nx
pnpm exec nx g @skein-js/nx:application --directory=apps/agent --storage=sqlite
pnpm install
pnpm exec nx dev apps-agent
```

Options: `directory` (required), `provider` (`none`, `google`, `anthropic`, `openai`),
`storage` (`memory`, `postgres`, `sqlite`), `linting` (default `true`).
Use `--linting=false` to omit ESLint and Prettier or `--dry-run` to preview.

Integrated and package workspaces are supported. Existing lifecycle scripts and root configuration
are preserved. Installation stays manual. Node 24 is recommended; engines support `^22.12.0 || ^24.0.0`.
Compatible numeric workspace pins are honored; unsupported numeric pins fail before writing.
Targets use existing Nx executors. Start depends on build, live targets are uncached, and only
`.skein/build` is cached. SQLite state stays outside that output.

Root ESLint/Prettier configurations and declared tool dependencies are inherited independently;
missing tools are added to the appropriate dependency owner. New files follow inherited formatting.
Cached targets include `^default` dependency sources, and build/typecheck/test depend on `^build`.
Workspace-library edits invalidate application caches. Preserve these inputs, ordering and SQLite
exclusions. See [workspace tooling](https://skein-js.github.io/skein-js/scaffolding).

The named root export `generateApplication` accepts an Nx Tree and these options.
The exact metadata export `@skein-js/nx/package.json` supports discovery.

See [scaffolding](https://skein-js.github.io/skein-js/scaffolding). Apache-2.0.
