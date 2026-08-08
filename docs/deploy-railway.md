# Deploy on Railway

Railway builds from a `Dockerfile` in your repo and offers Postgres and Redis plugins in the same
project, so a skein deployment is three services and two environment variables. It also gives you a
~30s stop signal, so in-flight runs drain cleanly on deploys.

Everything platform-agnostic — environment variables, pool sizing, probes, scaling caveats — is in
[deploy.md](./deploy.md).

## Contents

- [1. Provision Postgres](#1-provision-postgres)
- [2. Provision Redis](#2-provision-redis)
- [3. Deploy the app service](#3-deploy-the-app-service)
- [4. Wire the env vars](#4-wire-the-env-vars)
- [5. Set the health check](#5-set-the-health-check)
- [6. Verify](#6-verify)
- [Tuning & caveats](#tuning--caveats)

## 1. Provision Postgres

Railway's default Postgres works as-is — skein's base schema needs no extensions.

**If you use semantic search** (you set `store.index` in `langgraph.json`), provision Railway's
**pgvector Postgres template** instead. `CREATE EXTENSION` can only enable an extension the server
already has, and the default image doesn't ship pgvector; skein enables it for you on first boot when
it's available, and fails with a clear error when it isn't. See
[storage.md](./storage.md).

## 2. Provision Redis

Add a Redis database from the dashboard. Any recent Redis works — skein uses it for the run queue
(BullMQ) and cross-instance stream pub/sub. Set `maxmemory-policy` to `noeviction`.

## 3. Deploy the app service

Point a Railway service at your repo. Because the repo has a skein-generated `Dockerfile` (run
`skein build` once and commit it, or `skein dockerfile -o Dockerfile`), Railway builds from it
directly. BuildKit — Railway's default — honors the image's dependency **cache mount**, so redeploys
that don't change dependencies skip reinstalling them.

If your production dependencies include **private scoped packages**, the generated Dockerfile mounts
an optional `id=npmrc` BuildKit secret on the install step; supply it as a build secret so the install
authenticates without baking a token into any layer.

## 4. Wire the env vars

In the app service's **Variables**, use Railway
[reference variables](https://docs.railway.com/guides/variables#reference-variables) so the URLs track
the databases automatically:

```text
POSTGRES_URI = ${{ Postgres.DATABASE_URL }}
REDIS_URI    = ${{ Redis.REDIS_URL }}
```

The left-hand names are skein's; the <code v-pre>${{ … }}</code> references on the right are Railway's own provided
variables — keep those as Railway names them.

Prefer the **private** URLs (`*.railway.internal`): private networking is plaintext, so no TLS
configuration is needed, and it doesn't count against egress. `PORT` is injected by Railway
automatically — don't set it yourself.

## 5. Set the health check

In **Settings → Deploy**, set **Healthcheck Path** to `/ok`, so Railway gates a new deploy as healthy
before cutting over. skein serves it dependency-free
([why](./deploy.md#4-a-health-probe)).

## 6. Verify

Run the [verification sequence](./deploy.md#verify-a-deployment) against your service's public URL.

## Tuning & caveats

Pool budgets, run concurrency, shutdown windows and multi-instance behaviour are the same
everywhere — see [Sizing & tuning](./deploy.md#sizing--tuning) and
[Scaling past one instance](./deploy.md#scaling-past-one-instance). Railway-specific notes:

- **Private networking needs no TLS config.** Over `*.railway.internal` you need neither `sslmode`
  nor `DATABASE_SSL_NO_VERIFY`. Only set `DATABASE_SSL_NO_VERIFY=true` if you must use a public
  database URL presenting a self-signed certificate.
- **Replicas vs. your Postgres plan.** Each instance opens three pools, so
  `3 × PG_POOL_MAX × replicas` is what your plan's connection cap has to absorb — see
  [Connection budget](./deploy.md#connection-budget).
- **Railway's stop signal is generous** (~30s), so you can raise `SKEIN_SHUTDOWN_GRACE_MS` well above
  the 5s default and let long runs finish rather than be aborted on every deploy.
- **Background runs work by default.** Railway doesn't suspend instances between requests, so no
  special configuration is needed.
- **Zombie reaping.** The image handles signals itself; if your graphs spawn child processes, enable
  Railway's init/PID-1 reaping (the generated `compose.yaml` sets `init: true` for the local
  equivalent).
