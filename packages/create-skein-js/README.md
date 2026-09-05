# create-skein-js

Scaffold a [skein-js](https://github.com/skein-js/skein-js) project — a self-hosted
[Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for your
[LangGraph.js](https://docs.langchain.com/oss/javascript/langgraph/overview) agents.

```bash
npm create skein-js@latest my-agent
# or: pnpm create skein-js my-agent · yarn create skein-js my-agent · npx create-skein-js my-agent
```

```text
cd my-agent
npm run dev     →  http://localhost:2024           the Agent Protocol API
                →  http://localhost:2024/console   threads, live runs, time travel
```

No database, no Docker, and no API key — `echo` answers your first request immediately. With
`--provider` you also get a model-backed graph, and setting its key is listed as a step.

> Keep the `@latest`. Without it, npm's npx cache (and `pnpm dlx`'s 24-hour one) can serve a stale
> version of this package.

## What you get

A `langgraph.json` project driven by the `skein` CLI — the same lifecycle you ship with:

| Command        | What it does                                                           |
| -------------- | ---------------------------------------------------------------------- |
| `dev`          | In-memory drivers, hot reload, dev state persisted across restarts     |
| `dev:services` | Postgres + Redis via Docker Compose, for the durable `dev` and `start` |
| `dev:postgres` | The same hot reload, against the drivers production uses               |
| `build`        | Bundle the graphs to plain JavaScript in `.skein/build`                |
| `start`        | Serve that bundle — the production entrypoint                          |

Choosing Postgres at the storage prompt swaps the last two: `dev` becomes the durable spelling and
the in-memory one is emitted as `dev:memory`. Both are always present either way.

...plus an echo graph that runs with no credentials, a test for it, an optional model-backed ReAct
agent, and a README explaining every file.

## Options

```text
create-skein-js [directory]

  -m, --provider <name>   none | google | anthropic | openai   (default: prompted)
      --pm <name>         npm | pnpm | yarn | bun              (default: detected)
      --no-install        Skip installing dependencies             (else: prompted, default yes)
      --no-git            Skip initializing a git repository       (else: prompted)
  -y, --yes               Accept every default; never prompt
  -f, --force             Scaffold into a directory that is not empty
```

Everything is prompted when the terminal is interactive, and defaulted when it is not — so this is
safe to run in a Dockerfile or a CI job without hanging. Interactively that means five questions:
directory, model provider, local development storage, whether to install, and whether to initialize a
git repository. The last defaults to no inside an existing work tree, since nesting a repository in
yours is never the intent — and whichever way it goes, the closing output says what git actually did.

`--pm` stays a flag with no prompt: it is detected from `npm_config_user_agent`, so asking would be a
question whose answer is already known.

npm needs `--` before flags; `pnpm create` and `npx` do not:

```bash
npm create skein-js@latest my-agent -- --provider anthropic
pnpm create skein-js my-agent --provider anthropic
```

With a provider you get a second graph — a ReAct agent with a live weather tool. Setting its API key
is a step before `dev`: until it is set that graph fails to load, naming the variable it wants, while
the keyless `echo` graph keeps serving.

## Monorepos

Scaffold into the directory you want and it works anywhere:

```bash
npm create skein-js@latest apps/my-agent
```

In an Nx workspace, add a `project.json` next to it to get `nx dev my-agent` — see the
[scaffolding reference](https://skein-js.github.io/skein-js/scaffolding#nx-and-other-monorepos) for
the file to drop in.

## Docs

- [Your first agent](https://skein-js.github.io/skein-js/your-first-agent) — from empty directory to deployed
- [Scaffolding reference](https://skein-js.github.io/skein-js/scaffolding) — every flag and generator
- [skein-js docs](https://skein-js.github.io/skein-js/)

## License

Apache-2.0
