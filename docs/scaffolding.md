# Scaffolding a project

`create-skein-js` generates a working skein-js project from an empty directory. It is the fastest
path from nothing to a running agent server, and it is optional — everything it emits is a file you
could write yourself, and the last section shows you exactly that.

For a guided walkthrough rather than a reference, start with
[your first agent](./your-first-agent.md).

## Quick start

```bash
npm create skein-js@latest my-agent
```

```bash
pnpm create skein-js my-agent
yarn create skein-js my-agent
npx create-skein-js my-agent
```

**Keep the `@latest`.** Without it, npm's npx cache — and `pnpm dlx`'s 24-hour cache — can serve a
stale copy of the scaffolder.

## What it generates

```text
my-agent/
├── langgraph.json          Points skein at your graphs; the LangGraph CLI's format
├── package.json            The skein CLI lifecycle as scripts
├── tsconfig.json           Strict, ESM, bundler resolution
├── vitest.config.ts
├── compose.dev.yaml        Postgres + Redis — what `start` needs
├── .env                    Ready to use, gitignored — never overwritten if one already exists
├── .env.example            A committed reference copy of it
├── .gitignore
├── README.md               Explains each of these files
└── src/
    ├── echo-graph.ts       Runs with no API key, no network
    ├── echo-graph.test.ts  So `npm test` is green on the first commit
    └── agent-graph.ts      Only with --provider: a ReAct agent with a working tool
```

The scripts are the whole skein CLI lifecycle:

| Script         | Command                                      | What it does                                                |
| -------------- | -------------------------------------------- | ----------------------------------------------------------- |
| `dev`          | `skein dev --port 2024`                      | In-memory drivers, hot reload, state persisted to `.skein/` |
| `dev:services` | `docker compose -f compose.dev.yaml up -d`   | Postgres + Redis, for `dev:postgres` and `start`            |
| `dev:postgres` | `skein dev … --store postgres --queue redis` | The same hot reload, against the drivers production uses    |
| `build`        | `skein build --artifact-only`                | Graphs → plain JavaScript in `.skein/build`                 |
| `start`        | `skein start -c .skein/build/langgraph.json` | Serve that build — the production entrypoint                |
| `typecheck`    | `tsc --noEmit`                               |                                                             |
| `test`         | `vitest run`                                 |                                                             |

`start` names the artifact's own `langgraph.json` because `skein start` serves a _build_, not a source
project: it wants `schemas.json` beside the config it loads, and that file only exists in
`.skein/build`. Run from the project root like this, it also picks up the `POSTGRES_URI` and
`REDIS_URI` from the project's `.env` — `skein start` reads a conventional `.env` from its working
directory as well as from the config's, because an artifact deliberately carries none of its own (it
is the Docker build context). So `dev:services && build && start` works with nothing to edit first.

Two deliberate choices worth knowing:

- **`dev` never needs a credential or a service.** The `echo` graph is always present and always
  first in `graphs`, so the very first request works with an empty `.env`.
- **`compose.dev.yaml` is always generated**, not hidden behind a flag, and the `POSTGRES_URI` /
  `REDIS_URI` in `.env` are live rather than commented out. `skein start` is durable-only — it
  defaults to `--store postgres --queue redis` and fails without those two — so a project shipping a
  `start` script has to ship both the services and the URIs that reach them, or the script is a trap.
  The values are the ones the generated compose file serves, so there was never anything to decide.

## Options

```text
create-skein-js [directory]

  -m, --provider <name>   none | google | anthropic | openai   (default: prompted, else none)
      --pm <name>         npm | pnpm | yarn | bun              (default: detected)
      --no-install        Skip installing dependencies
      --no-git            Skip initializing a git repository
  -y, --yes               Accept every default; never prompt
  -f, --force             Scaffold into a directory that is not empty
  -v, --version
  -h, --help
```

**Passing flags through npm** needs a `--` separator. `pnpm create` and `npx` do not:

```bash
npm create skein-js@latest my-agent -- --provider anthropic
pnpm create skein-js my-agent --provider anthropic
```

### `--provider`

|                    | Package added             | `.env.example` gains | Emits `agent-graph.ts`? |
| ------------------ | ------------------------- | -------------------- | ----------------------- |
| `none` _(default)_ | —                         | —                    | no                      |
| `google`           | `@langchain/google-genai` | `GOOGLE_API_KEY`     | yes                     |
| `anthropic`        | `@langchain/anthropic`    | `ANTHROPIC_API_KEY`  | yes                     |
| `openai`           | `@langchain/openai`       | `OPENAI_API_KEY`     | yes                     |

With a provider you also get a ReAct agent wired to a live weather tool that needs no key of its own,
so the agent is genuinely runnable the moment you add your model key.

Until the key is set, `agent` fails to load naming the variable it wants — a
[load-failure block](./errors-and-logging.md#the-load-failure-block), while `echo` keeps serving.
`skein dev` watches `.env`, so filling the key in takes effect on save.

### Behaviour you can rely on

- **It never hangs unattended.** Prompts appear only when both streams are a TTY, `--yes` was not
  passed, and `CI` is unset. Otherwise it takes the flag, then the default — safe inside a Dockerfile
  or a CI job.
- **A failed install is not fatal.** Your files are already written; the closing output just adds
  `install` back to the steps.
- **Scaffolding into a fresh clone works.** A directory holding only `.git`, `LICENSE`, editor
  folders or `.DS_Store` counts as empty, so "create an empty repo, clone it, scaffold into it" needs
  no `--force`.
- **git is skipped inside an existing work tree**, so it never nests a repository in yours.
- **The version is pinned to a matching runtime.** Because every `packages/*` shares one version,
  `create-skein-js@x.y.z` pins `skein-js@^x.y.z` — the scaffolder and the runtime it scaffolds are
  always the same release.

## Nx and other monorepos

Scaffold into whatever directory you want — the generated project is self-contained, so it works
inside a workspace as-is:

```bash
npm create skein-js@latest apps/my-agent
```

There is deliberately **no skein Nx plugin**. A generator collection would be permanent public API
tracking Nx's release cadence, and it would buy you one file you can write once and own yourself.
Here is that file — `apps/my-agent/project.json`:

```json
{
  "name": "my-agent",
  "projectType": "application",
  "targets": {
    "dev": {
      "executor": "nx:run-commands",
      "cache": false,
      "options": { "command": "skein dev --port 2024", "cwd": "apps/my-agent" }
    },
    "build": {
      "executor": "nx:run-commands",
      "options": { "command": "skein build --artifact-only", "cwd": "apps/my-agent" }
    },
    "start": {
      "executor": "nx:run-commands",
      "cache": false,
      "options": { "command": "skein start", "cwd": "apps/my-agent" }
    },
    "typecheck": {
      "executor": "nx:run-commands",
      "options": { "command": "tsc --noEmit", "cwd": "apps/my-agent" }
    }
  }
}
```

`dev` and `start` are marked `"cache": false` because a long-running server has no meaningful cached
result. Explicit targets work on every Nx version, with no plugin to install and nothing to migrate.

To share the workspace's TypeScript settings, replace the generated `tsconfig.json` with one that
extends your base:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "types": ["node"] },
  "include": ["src/**/*.ts"]
}
```

The same approach works for Turborepo, pnpm workspaces, or plain npm workspaces — the project is
just a package with a `langgraph.json` in it.

## If you don't want the scaffolder

Nothing here is load-bearing. Two alternatives:

**Copy a runnable example.** The [`examples/`](https://github.com/skein-js/skein-js/tree/main/examples)
directory has one project per framework and pattern:

```bash
npx degit skein-js/skein-js/examples/express-basic my-agent
```

Note that this copies from `main`, which tracks unreleased work: the examples depend on
`workspace:*` versions that only resolve inside the monorepo, so you will need to replace those with
real version ranges. The scaffolder exists partly to avoid exactly that.

**Write the three files yourself.** A skein project is a graph, a `langgraph.json`, and the CLI:

```bash
npm install -D skein-js
npm install @langchain/core @langchain/langgraph
```

```ts
// src/graph.ts
import { AIMessage } from "@langchain/core/messages";
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";

export const graph = new StateGraph(MessagesAnnotation)
  .addNode("echo", (state) => ({
    messages: [new AIMessage(`echo: ${state.messages.at(-1)?.content}`)],
  }))
  .addEdge("__start__", "echo")
  .addEdge("echo", "__end__")
  .compile();
```

```json
// langgraph.json
{ "node_version": "24", "graphs": { "agent": "./src/graph.ts:graph" }, "env": ".env" }
```

Add `"type": "module"` to your `package.json`, then `npx skein dev`. That is the entire contract —
see [langgraph-cli-compat.md](./langgraph-cli-compat.md) for every field it accepts.

## See also

- [Your first agent](./your-first-agent.md) — the guided version of all of this
- [Getting started](./getting-started.md) — the paths for when you already have a graph
- [LangGraph CLI compatibility](./langgraph-cli-compat.md) — every `langgraph.json` field
