# Deploy on Railway

**Postgres and Redis are required for Skein’s standard production server.** Create both database
services in the same Railway project and environment as your app, then deploy a prebuilt Skein
image.

Everything platform-agnostic — environment variables, pool sizing, probes, scaling caveats — is in
[deploy.md](./deploy.md).

## 1. Provision Postgres

On the project canvas, choose **+ New**, add **PostgreSQL**, and wait for the service to start. Use
the `DATABASE_URL` from the Postgres service’s **Variables** tab. For semantic search
(`store.index` in `langgraph.json`), choose a Postgres template that ships pgvector and find its
direct database URL. Skein sets up the schema and enables the installed extension on startup.
[Railway Postgres setup](https://docs.railway.com/databases/postgresql)

## 2. Provision Redis

Choose **+ New** again and add **Redis**. The Redis service’s **Variables** tab exposes its
private `REDIS_URL`. Use a dedicated Redis service for the queue. From a shell in the Redis
service, check that the Redis server reports `noeviction`:

```bash
REDISCLI_AUTH="$REDISPASSWORD" redis-cli -p "$REDISPORT" CONFIG GET maxmemory-policy
```

If you use a customized Redis service, set `maxmemory-policy noeviction` in its Redis configuration
so the setting survives a redeploy. [Railway Redis setup](https://docs.railway.com/databases/redis)

## 3. Deploy the app service

Sign in to a container registry that Railway can pull from. From the graph project directory,
build and push an image with its bundled graphs. Replace the image name with your registry path:

```bash
export DOCKER_DEFAULT_PLATFORM=linux/amd64
IMAGE=ghcr.io/your-org/skein-app:v1
skein build -t "$IMAGE"
docker push "$IMAGE"
```

On the project canvas, choose **+ New → Docker Image** and enter that tag. For a private registry,
configure the service’s registry credentials. Add any model or tool secrets the graph needs as
service variables. [Railway image services](https://docs.railway.com/services)

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

Replace `Postgres` or `Redis` in these references if you gave the services different names. The
resolved hostnames should end in `.railway.internal`. Keep any TLS options required by your
database template. Railway injects `PORT` automatically.

## 5. Set the health check

In **Settings → Deploy**, set **Healthcheck Path** to `/ok`, so Railway gates a new deploy as healthy
before cutting over. skein serves it dependency-free
([why](./deploy.md#4-a-health-probe)).

## 6. Verify

After configuring [application auth](./deploy.md#5-auth--read-this-before-you-expose-it), create a
domain under **Settings → Networking**. Run the
[verification sequence](./deploy.md#verify-a-deployment) against that URL.

## Tuning & caveats

Pool budgets, run concurrency, shutdown windows and multi-instance behaviour are the same
everywhere — see [Sizing & tuning](./deploy.md#sizing--tuning) and
[Scaling past one instance](./deploy.md#scaling-past-one-instance). Railway-specific notes:

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
