# skein-js

> The `skein` CLI — self-host your LangGraph.js agents as an open-source alternative to LangGraph
> Platform, with a drop-in replacement for the LangGraph CLI (`dev` / `up` / `build` / `dockerfile`).

Part of **[skein-js](../../README.md)** — the open-source alternative to LangGraph Platform for TypeScript: a self-hosted [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

**Status:** 🚧 Pre-alpha — `dev`, `up`, `build`, and `dockerfile` all work today.

This is the only package most projects install. Point `skein` at your existing `langgraph.json` and
your graph code, config, and clients keep working unchanged — the swap from the LangGraph CLI is a
one-word change (`langgraph dev` → `skein dev`).

## Contents

- [Install](#install)
- [Usage](#usage)
- [Commands](#commands)
- [`skein dev` flags](#skein-dev-flags)
- [Self-hosted, no lock-in](#self-hosted-no-lock-in)
- [Deploy anywhere](#deploy-anywhere)
- [When the managed platform may fit you better](#when-the-managed-platform-may-fit-you-better)
- [Learn more](#learn-more)
- [License](#license)

## Install

```bash
pnpm add -D skein-js            # or: npm i -D skein-js  ·  yarn add -D skein-js
```

## Usage

Swap it into your `package.json` scripts — your `langgraph.json` is unchanged:

```jsonc
{
  "scripts": {
    "dev": "skein dev", // was: "langgraph dev"
    "up": "skein up", //  was: "langgraph up"
  },
}
```

Then run the dev server (in-process, hot reload, no Docker):

```bash
pnpm skein dev                 # → http://127.0.0.1:2024
```

Talk to it with the official `@langchain/langgraph-sdk` client, `useStream`, Agent Chat UI, or
LangGraph Studio — any Agent Protocol client works with only a URL change. See the
[Quick start](../../README.md#quick-start).

## Commands

| Command            | What it does                                                        | LangGraph CLI equivalent | Key flags                                                                                   |
| ------------------ | ------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `skein dev`        | In-process dev server, hot reload, `.skein/` state, no Docker.      | `langgraph dev`          | see [`skein dev` flags](#skein-dev-flags)                                                   |
| `skein up`         | Self-hosted stack via Docker Compose (app + Postgres + Redis).      | `langgraph up`           | `-p, --port` (8123) · `--host` (0.0.0.0) · `-n, --npmrc <path>`                             |
| `skein build`      | Build a deployable Docker image from the config.                    | `langgraph build`        | `-t, --tag` (defaults to the project dir name) · `-n, --npmrc <path>`                       |
| `skein dockerfile` | Emit a standalone Dockerfile (stdout by default).                   | `langgraph dockerfile`   | `-o, --output <path>`                                                                       |
| `skein start`      | Serve a pre-built `.skein/build` artifact (the image's entrypoint). | —                        | `-p, --port` (8123) · `--host` · `--store` (postgres) · `--queue` (redis) · `--concurrency` |

All commands take `-c, --config <path>` (default `langgraph.json`).

`--npmrc <path>` (on `build`/`up`) mounts an `.npmrc` as a BuildKit secret so the image's dependency
install can authenticate against a **private/authenticated npm registry** without baking a token into
any layer. Public-registry builds don't need it.

## `skein dev` flags

| Flag                      | Values               | Default     | Notes                                                                              |
| ------------------------- | -------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `-p, --port`              | number               | `2024`      | Port to listen on.                                                                 |
| `--host`                  | host                 | `127.0.0.1` | Interface to bind.                                                                 |
| `--store <driver>`        | `memory`, `postgres` | `memory`    | `postgres` reads `POSTGRES_URI`; also selects `PostgresSaver`.                     |
| `--queue <driver>`        | `memory`, `redis`    | `memory`    | `redis` reads `REDIS_URI` (BullMQ queue + Redis Streams bus).                      |
| `--concurrency`           | number               | `10`        | Queued runs the background worker executes at once.                                |
| `-n, --n-jobs-per-worker` | number               | `10`        | LangGraph-compatible alias for `--concurrency`.                                    |
| `--no-persist`            | —                    | persists    | Don't snapshot dev state to `.skein/` across restarts.                             |
| `--no-reload`             | —                    | reloads     | Disable hot reload on source change.                                               |
| `-v, --verbose`           | —                    | off         | Log per-run activity (tool calls, interrupts, timing). Failures are always logged. |
| `--request-log`           | —                    | on          | A line per HTTP request. `--no-request-log` turns it off; env `SKEIN_REQUEST_LOG`. |
| `--run-timeout <ms>`      | number               | off         | Abort a run executing longer than this; env `SKEIN_RUN_TIMEOUT_MS`.                |

`--concurrency`, `-n, --n-jobs-per-worker`, and `--run-timeout` are accepted by `skein start` too. The
first two also read
`SKEIN_RUN_CONCURRENCY` (or `N_JOBS_PER_WORKER`) when no flag is passed — the path that reaches a
container. See [runs-and-redis.md](../../docs/runs-and-redis.md#run-concurrency).

**`skein start` takes `--store` and `--queue` too, but only the durable values.** It is the production
entrypoint: `--store postgres` and `--queue redis` are its defaults, and `--store memory` is rejected at
parse time. It used to default to the in-memory drivers, with only the generated Dockerfile's CMD
flipping them — so any CMD override, or a hand-rolled `docker run`, quietly produced a production server
with a process-local queue and state that vanished on restart. For a local run with no infrastructure use
`skein dev`; to develop against production drivers, `skein dev --store postgres --queue redis`.

`skein start` also defaults `--request-log` **off**: it always passes a logger (that is how a failed run
gets reported at all), and a line per request under production traffic buries those reports. Pass
`--request-log` or `SKEIN_REQUEST_LOG=1` to turn it on.

The combination `--store postgres --queue memory` — durable state, process-local queue, single instance —
is still fully supported, but on the **embedded** path where it is documented
([embedding.md](../../docs/embedding.md), `embedPostgresGraphs` with no `REDIS_URI`) rather than on the
container entrypoint.

`skein dev --store postgres --queue redis` is a capability the LangGraph CLI does **not** offer: it
lets you develop against **production-shaped** storage (durable Postgres checkpoints, pgvector
search, cross-instance Redis streaming) with hot reload and no Docker. Full mapping and the
annotated `langgraph.json`: [docs/langgraph-cli-compat.md](../../docs/langgraph-cli-compat.md).

## Self-hosted, no lock-in

skein-js is **Apache-2.0** and builds only on the **MIT-licensed** `@langchain/*` packages, so you
run your LangGraph.js graphs behind the standard Agent Protocol on **your own infrastructure** — no
license key, no per-deployment fee, and no vendor lock-in. `skein up` brings up a Docker Compose
stack (app + your Postgres + your Redis) that you own end to end.

## Deploy anywhere

`skein build` produces an ordinary Docker image, so your LangGraph.js graphs run **anywhere you can
run a container** — Google Cloud Run, Railway, Fly.io, Render, AWS App Runner or ECS Fargate,
Kubernetes, or your own VPS.

```bash
skein build -t my-agent            # → a deployable Docker image
docker run -p 8123:8123 \
  -e POSTGRES_URI="postgresql://…" \
  -e REDIS_URI="redis://…" my-agent
```

The image binds `$PORT` when a platform injects one (8123 when nothing does), runs as a non-root
user, serves a `/ok` health probe, and drains in-flight runs on `SIGTERM`. Step-by-step guides per
platform, and the knobs that are the same everywhere: [deploy anywhere](../../docs/deploy.md).

## When the managed platform may fit you better

skein-js gives you the code and full ownership, not a support contract. If you're an established
product that wants a vendor standing behind your agent stack — dedicated support with response-time
SLAs, plus enterprise features like SSO, RBAC, and SOC2 — LangGraph Platform's Enterprise plan is a
sound choice. Your graph code and `langgraph.json` stay unchanged either way, so switching between
them is cheap. See the [reuse-first architecture](../../docs/reuse.md) for how little skein-js adds
on top of the open LangGraph runtime.

## Learn more

- [Deploy anywhere](../../docs/deploy.md) — Cloud Run, Railway, Fly.io, Render, AWS, Kubernetes, VPS
- [LangGraph CLI compatibility](../../docs/langgraph-cli-compat.md) — commands + `langgraph.json` fields
- [skein-js overview](../../docs/index.md) · [Reuse-first architecture](../../docs/reuse.md) · [Roadmap](../../docs/roadmap.md)
- [skein-js root README](../../README.md)

## License

[Apache-2.0](../../LICENSE)
