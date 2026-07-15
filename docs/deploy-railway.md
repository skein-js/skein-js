# Deploying on Railway

skein has no `skein deploy` — it's self-hosted by design ([roadmap.md](./roadmap.md)). What it
_does_ ship is a PaaS-friendly Docker image (`skein build` / `skein dockerfile`), so deploying on
[Railway](https://railway.com) — or Fly, Render, Heroku — is just "build the image, give it a
Postgres and a Redis, set two env vars." This guide walks the Railway path; nothing here is
Railway-specific beyond the dashboard steps.

> The generated image runs the same engine as `skein dev`, with reload/persistence off and durable
> drivers on (`--store postgres --queue redis`). See [runs-and-redis.md](./runs-and-redis.md) for the
> production topology it mirrors.

## What the image already does for you

- **Binds the injected port.** The container CMD passes no `--port`; the server reads `PORT` from the
  environment. Railway injects `PORT`, so the app binds it with no configuration. (Locally, `skein up`
  sets `PORT` in `compose.yaml` to match the published port.)
- **Runs as non-root** (`USER node`) and keeps node as PID 1 (exec-form CMD), so Railway's stop signal
  (`SIGTERM`) reaches skein's graceful-shutdown handler — in-flight runs drain, pools close cleanly.
- **Reads config from the environment** — `DATABASE_URL` and `REDIS_URL` only, each required only for
  the durable driver that uses it.

## Steps

### 1. Provision Postgres

- **No semantic search?** Railway's default Postgres works as-is. skein's base schema needs no
  extensions.
- **Using semantic search** (you set `store.index` in `langgraph.json`)? You need pgvector.
  `CREATE EXTENSION` can only _enable_ an extension the server already has installed — it can't add
  pgvector to a server that lacks it, and Railway's default Postgres doesn't ship it. Provision
  Railway's **pgvector Postgres template** instead. skein then enables it for you on first boot with
  `CREATE EXTENSION IF NOT EXISTS vector` (see [storage.md](./storage.md)); if pgvector is missing
  you'll get a clear error telling you to switch images.

### 2. Provision Redis

Add a Redis database from the Railway dashboard. Any recent Redis works; skein uses it for the run
queue (BullMQ) and cross-instance stream pub/sub.

### 3. Deploy the app service

Point a Railway service at your repo. Because the repo has a skein-generated `Dockerfile` (run
`skein build` once and commit it, or `skein dockerfile > Dockerfile`), Railway builds from it
directly. BuildKit — Railway's default — honors the image's dependency **cache mount**, so redeploys
that don't change the lockfile skip reinstalling dependencies.

### 4. Wire the env vars

In the app service's **Variables**, add Railway [reference variables](https://docs.railway.com/guides/variables#reference-variables)
so the URLs track the databases automatically:

```text
DATABASE_URL = ${{ Postgres.DATABASE_URL }}
REDIS_URL    = ${{ Redis.REDIS_URL }}
```

Prefer the **private** URLs (`*.railway.internal`) — private networking is plaintext, so no TLS
config is needed, and it doesn't count against egress. `PORT` is injected by Railway automatically; do
not set it yourself.

### 5. Set the health check

In **Settings → Deploy**, set **Healthcheck Path** to `/ok`. skein serves it as a dependency-free
liveness probe (`200 {"ok": true}`), so Railway can gate a new deploy as healthy before cutting over —
zero-downtime rollouts. It deliberately does _not_ probe Postgres/Redis, so a transient database blip
won't flap a healthy instance.

## Tuning & caveats

- **Connection limits.** skein opens **two** Postgres pools per instance — the resource store and
  LangGraph's `PostgresSaver` (checkpoints). Multiply by your replica count against Railway's Postgres
  connection cap. Cap the store pool with **`PG_POOL_MAX`** (e.g. `PG_POOL_MAX=5`); the saver pool is
  managed by LangGraph and sized separately, so budget for both.
- **Public database URLs.** If you must use a public Postgres URL that presents a self-signed
  certificate, set **`DATABASE_SSL_NO_VERIFY=true`** to skip cert verification. A URL with
  `?sslmode=require` and a proper CA chain needs nothing extra — `pg` honors `sslmode`. Not needed at
  all over private networking.
- **Scaling.** With Postgres + Redis, replicas share state and streams (a client can join a run on
  another instance), so horizontal scaling works. Schema migrations run on every boot and are
  idempotent + advisory-locked, so concurrent rollouts are safe.
- **Zombie reaping.** The image handles signals itself; if you run graphs that spawn child processes,
  enable Railway's init/PID-1 reaping (the generated `compose.yaml` sets `init: true` for the local
  equivalent).

## Environment variables

| Variable                 | Required             | Purpose                                                       |
| ------------------------ | -------------------- | ------------------------------------------------------------- |
| `DATABASE_URL`           | yes (postgres store) | Postgres connection string (resources + checkpoints).         |
| `REDIS_URL`              | yes (redis queue)    | Redis connection string (run queue + stream pub/sub).         |
| `PORT`                   | injected by Railway  | Port the server binds. Do not set manually on Railway.        |
| `PG_POOL_MAX`            | no                   | Max connections in the store pool (`pg` default 10).          |
| `DATABASE_SSL_NO_VERIFY` | no                   | `true` to skip TLS cert verification (self-signed public DB). |
