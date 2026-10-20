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

The default storage choice is `memory`. It keeps development simple and supplies Postgres/Redis
services for the default production `start`. Choose `--storage sqlite` for a local application;
its generated scripts and files differ as described below.

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

| Script         | Command                                           | What it does                                                |
| -------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| `dev`          | `skein dev --port 2024`                           | In-memory drivers, hot reload, state persisted to `.skein/` |
| `dev:services` | `docker compose -f compose.dev.yaml up -d --wait` | Postgres + Redis, for the durable `dev` and for `start`     |
| `dev:postgres` | `skein dev … --store postgres --queue redis`      | The same hot reload, against the drivers production uses    |
| `build`        | `skein build --artifact-only`                     | Graphs → plain JavaScript in `.skein/build`                 |
| `start`        | `skein start -c .skein/build/langgraph.json`      | Serve that build — the production entrypoint                |
| `typecheck`    | `tsc --noEmit`                                    |                                                             |
| `test`         | `vitest run`                                      |                                                             |

Those are the default memory scripts. Pick Postgres and `dev` becomes the Postgres/Redis command,
with the in-memory alternative emitted as `dev:memory` instead of `dev:postgres`.

`dev:services` uses `--wait` so it returns once both healthchecks pass, not merely once the containers
exist — otherwise the very next command races first-boot `initdb`.

`start` names the artifact's own `langgraph.json` because `skein start` serves a _build_, not a source
project: it wants `schemas.json` beside the config it loads, and that file only exists in
`.skein/build`. Run from the project root like this, it also picks up the `POSTGRES_URI` and
`REDIS_URI` from the project's `.env` — `skein start` reads a conventional `.env` from its working
directory as well as from the config's, because an artifact deliberately carries none of its own (it
is the Docker build context). So `dev:services && build && start` works with nothing to edit first.

Two deliberate choices worth knowing:

- **The default `dev` needs no credential or service.** The `echo` graph is always present and
  first in `graphs`, so the first request works with an empty `.env` and memory drivers.
- **Memory and Postgres projects include `compose.dev.yaml`**, and the `POSTGRES_URI` /
  `REDIS_URI` in `.env` are live rather than commented out. The default `skein start` selects
  `--store postgres --queue redis` and requires those services, so a project shipping that
  `start` script has to ship both the services and the URIs that reach them, or the script is a trap.
  The values are the ones the generated compose file serves, so there was never anything to decide.

### SQLite projects

```bash
npm create skein-js@latest my-app -- --storage sqlite
cd my-app
npm run dev
npm run build
npm start
```

SQLite projects install `@skein-js/local`, LangGraph, and its SQLite saver. Both `dev` and `start`
select `--store sqlite --queue sqlite`, with the database at `.skein/state.sqlite`; `dev:memory`
keeps the memory alternative. There is no Compose file, service-start script, or Postgres/Redis
environment configuration. Graphs still build to `.skein/build` and the database stays outside it.
Use Node 22/24. See [local deployment](./local-deployment.md) for embedding and desktop examples.

## Options

```text
create-skein-js [directory]

  -m, --provider <name>   none | google | anthropic | openai   (default: prompted, else none)
      --storage <name>    memory | postgres | sqlite          (default: prompted, else memory)
      --pm <name>         npm | pnpm | yarn | bun              (default: detected)
      --linting / --no-linting  ESLint and Prettier (default: yes)
      --no-workspace-update Leave workspace registration manual
      --no-install        Skip installing dependencies                (else: prompted, default yes)
      --no-git            Skip initializing a git repository          (else: prompted)
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
- **git is skipped inside an existing work tree**, so it never nests a repository in yours — and the
  closing output says so, rather than leaving you to infer it from a missing `.git`. A failure (git
  absent, or no `user.email` configured) is reported too, and distinctly: the two used to be the same
  silent non-event.
- **The version is pinned to a matching runtime.** Because every `packages/*` shares one version,
  `create-skein-js@x.y.z` pins `skein-js@^x.y.z` — the scaffolder and the runtime it scaffolds are
  always the same release.

## Tooling and Node versions

ESLint and Prettier default to enabled in both entrypoints. The CLI asks **Y/n** interactively;
`--linting` and `--no-linting` bypass that prompt. `--yes`, CI and non-TTY runs enable tooling.
The Nx option `linting` defaults to `true`; use `--linting=false` to opt out.

Projects provide `lint`, `format`, and `format:check`. Missing tooling uses recommended JavaScript
and TypeScript ESLint rules and Prettier with `printWidth: 100`. Existing root ESLint and Prettier
configurations are inherited independently. Generated output, dependencies, runtime state and package-manager lockfiles are ignored.

The shared policy recommends **Node 24** with engines `^22.12.0 || ^24.0.0`. It derives `.nvmrc`
and `langgraph.json.node_version` from the same selection. Compatible numeric workspace pins in
`.nvmrc` or `.node-version` are honored. Unsupported numeric pins fail before writing; unresolved
aliases such as `lts/*` produce an explanation and fall back to Node 24. Review the policy when Node 26
enters LTS in October 2026, after native SQLite and desktop CI gates pass.

## Nx and other monorepos

For Nx **23.2.1 through 23.x**, install the generator at the root:

```bash
pnpm add -D @skein-js/nx
pnpm exec nx g @skein-js/nx:application --directory=apps/my-agent --storage=sqlite
pnpm install
pnpm exec nx dev apps-my-agent
```

Options are `directory` (required), `provider`, `storage`, and `linting`.
The generator supports integrated workspaces (root dependencies) and package workspaces (application
dependencies). It extends the TypeScript base, preserves root lifecycle scripts and leaves installation
manual. Use `--dry-run` to preview without writing. This replaces issue #19's earlier decision to
document manual wiring only; existing projects can retain their targets.

Targets use existing `nx:run-commands`. `start` depends on `build`, live targets are uncached,
and only `.skein/build` is a build output. SQLite state and WAL/SHM files stay outside cached
inputs and outputs. Retain explicit artifact selection and storage flags, for example
`skein start -c .skein/build/langgraph.json --store sqlite --queue sqlite`.
When a diagnostic suggests a config, keep the original command's other options, including custom
`--sqlite-path` settings.

For npm, pnpm, Yarn, Bun, Turborepo or Lerna workspaces:

```bash
npm create skein-js@latest apps/my-agent
```

The CLI retains that directory, detects the workspace and skips installation. Missing registration
is prompted with a yes default; `--yes` accepts and `--no-workspace-update` leaves manual
instructions. Existing globs, exclusions, YAML comments, key order, versions and unrelated settings are
preserved. A pnpm root without `pnpm-workspace.yaml` gets one containing its existing `package.json`
workspace patterns and exclusions, since pnpm ignores `package.json` `workspaces`. Invalid declared
workspaces are diagnosed even when another manifest field is invalid. Excluded paths, invalid root
metadata, duplicate names and package-manager conflicts fail before writing.

Workspace `packageManager` metadata takes precedence over lockfile detection. Compatible root or
pnpm catalog ranges are reused, then unanimous compatible sibling ranges. Remaining dependencies use
tested defaults and report differences. Integrated Nx workspaces reject root dependency conflicts
without changing existing versions. In Nx workspaces the CLI directs you to the generator before writing.

## Scaffold validation

The internal `scripts/scaffold-cases.json` catalog drives 96 generation combinations and 30 installed
consumers: every package-manager/storage and provider/storage pair, opt-outs, independent tooling
inheritance, and both Nx layouts on Node 22.12 and 24.

CI builds and packs the commit once and distributes tarballs. Consumers install outside the checkout,
verify transitive Skein artifact hashes, run typechecking, tests, applicable lint/format checks and
build, then send echo requests to development and artifact servers. Dummy keys allow provider graph
building without model calls. SQLite always executes on Node. Required durable cases fail without Docker.
The matrix pins npm 11.12.1 (including its tarball-override resolver fixes) and uses Yarn's node-modules linker. These checks also gate npm publication. Registry smoke tests and SQLite/desktop platform gates remain.

```bash
pnpm exec nx run test-support:pack-scaffolds
pnpm exec nx run test-support:scaffold-consumers --case=standalone-npm-sqlite
```

The new `@skein-js/nx` package follows the fixed release group. Its tarball includes generator
metadata, schema and declarations without a private runtime dependency. First publication uses the
release workflow's existing bootstrap credentials; configure npm trusted publishing afterward.

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
