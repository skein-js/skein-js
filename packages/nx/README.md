# @skein-js/nx

Generate a skein-js LangGraph application in Nx 23.2.1 through 23.x.

```bash
pnpm add -D @skein-js/nx
pnpm exec nx g @skein-js/nx:application --directory=apps/agent --storage=sqlite
pnpm install
pnpm exec nx dev apps-agent
```

Options: `directory` (required), `provider` (`none`, `google`, `anthropic`, `openai`),
`storage` (`memory`, `postgres`, `sqlite`), `linting` (default `true`).
Use `--linting=false` to omit ESLint and Prettier or `--dry-run` to preview.

Integrated and package workspaces are supported. Existing lifecycle scripts and root configuration
are preserved. Installation stays manual. Node 24 is recommended; engines support Node 22.12+ and 24.x.
Targets use existing Nx executors. Start depends on build, live targets are uncached, and only
`.skein/build` is cached. SQLite state stays outside that output.

The named root export `generateApplication` accepts an Nx Tree and these options.
The exact metadata export `@skein-js/nx/package.json` supports discovery.

See [scaffolding](https://skein-js.github.io/skein-js/scaffolding). Apache-2.0.
