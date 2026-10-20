# create-skein-js

Scaffold a [skein-js](https://github.com/skein-js/skein-js) project — a self-hosted
[Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for your
[LangGraph.js](https://docs.langchain.com/oss/javascript/langgraph/overview) agents.

📖 **Docs:** [Scaffolding a project](https://skein-js.github.io/skein-js/scaffolding)

```bash
npm create skein-js@latest my-agent
# or: pnpm create skein-js@latest my-agent · yarn create skein-js@latest my-agent · npx create-skein-js@latest my-agent
```

```text
cd my-agent
npm run dev     →  http://localhost:2024           the Agent Protocol API
                →  http://localhost:2024/console   threads, live runs, time travel
```

No database, no Docker, and no API key — `echo` answers your first request immediately. With
`--provider` you also get a model-backed graph, and setting its key is listed as a step.

> Keep `@latest` to request the latest published scaffolder instead of relying on a cached version.

## What you get

A `langgraph.json` project driven by the `skein` CLI — the same lifecycle you ship with:

| Command        | What it does                                                           |
| -------------- | ---------------------------------------------------------------------- |
| `dev`          | In-memory drivers, hot reload, dev state persisted across restarts     |
| `dev:services` | Postgres + Redis via Docker Compose, for the durable `dev` and `start` |
| `dev:postgres` | The same hot reload, against the drivers production uses               |
| `build`        | Bundle the graphs to plain JavaScript in `.skein/build`                |
| `start`        | Serve that bundle — the production entrypoint                          |

Choosing Postgres at the storage prompt makes `dev` use Postgres/Redis and emits `dev:memory`
as the alternative. SQLite emits `dev` and `start` with the SQLite store/queue pair and omits Compose.
Both durable choices retain the memory alternative.

...plus an echo graph that runs with no credentials, a test for it, an optional model-backed ReAct
agent, and a README explaining every file.

Node 24 is recommended; generated engines support `^22.12.0 || ^24.0.0 || ^26.0.0`. ESLint and Prettier default
on, with `lint`, `format`, and `format:check` scripts. Root configurations are inherited independently;
missing tool dependencies are added, and generated files follow inherited Prettier settings. See
[workspace tooling](https://skein-js.github.io/skein-js/scaffolding).

## Options

```text
create-skein-js [directory]

  -m, --provider <name>   none | google | anthropic | openai   (default: prompted)
      --pm <name>         npm | pnpm | yarn | bun              (default: detected)
      --storage <name>    memory | postgres | sqlite
      --linting / --no-linting  ESLint and Prettier (default: enabled)
      --no-workspace-update Leave registration manual
      --no-install        Skip installing dependencies             (else: prompted, default yes)
      --no-git            Skip initializing a git repository       (else: prompted)
  -y, --yes               Accept every default; never prompt
  -f, --force             Scaffold into a directory that is not empty
```

Everything is prompted when the terminal is interactive, and defaulted when it is not — so this is
safe to run in a Dockerfile or a CI job without hanging. Interactive prompts include tooling (Y/n),
directory, model provider, local development storage, whether to install, and whether to initialize a
git repository. The last defaults to no inside an existing work tree, since nesting a repository in
yours is never the intent — and whichever way it goes, the closing output says what git actually did.

`--pm` selects the manager for a standalone project. In a workspace, `packageManager` metadata
and lockfiles determine the manager; a conflicting explicit `--pm` fails before writing. Otherwise
the invoking manager's `npm_config_user_agent` is used, with npm as the fallback.

npm needs `--` before flags; `pnpm create` and `npx` do not:

```bash
npm create skein-js@latest my-agent -- --provider anthropic
pnpm create skein-js@latest my-agent --provider anthropic
```

With a provider you get a second graph — a ReAct agent with a live weather tool. Setting its API key
is a step before `dev`: until it is set that graph fails to load, naming the variable it wants, while
the keyless `echo` graph keeps serving.

## Monorepos

Choose a new child directory from your workspace root:

```bash
npm create skein-js@latest apps/my-agent
```

Workspace generation leaves installation manual, even with `--yes`. Accept registration or use
`--no-workspace-update` and register the package yourself, then install from the workspace root.
Existing patterns and exclusions are preserved, including when creating missing pnpm workspace YAML.

In Nx 23.2.1 through 23.x, install `@skein-js/nx` at the root (`pnpm add -Dw @skein-js/nx`) and run
`pnpm exec nx g @skein-js/nx:application --directory=apps/my-agent`. The CLI redirects for new child
directories in Nx workspaces. Workspace-root targets, including `create-skein-js . --force`, are
rejected before writes. See [workspace tooling](https://skein-js.github.io/skein-js/scaffolding).

## Docs

- [Your first agent](https://skein-js.github.io/skein-js/your-first-agent) — from empty directory to deployed
- [Scaffolding reference](https://skein-js.github.io/skein-js/scaffolding) — every flag and generator
- [skein-js docs](https://skein-js.github.io/skein-js/)

## License

Apache-2.0
