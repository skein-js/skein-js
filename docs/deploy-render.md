# Deploy on Render

Render builds from a `Dockerfile` in your repo (or pulls a pre-built image), and offers managed
Postgres and Key Value (Redis) in the same dashboard — so a skein deployment is three linked services
and two environment variables.

Everything platform-agnostic — environment variables, pool sizing, probes, scaling caveats — is in
[deploy.md](./deploy.md).

## Before you start

A Render account and a Git repo. Render builds remotely, so no local Docker is needed.

## 1. Commit the Dockerfile

```bash
skein dockerfile -o Dockerfile
```

Commit it, and make sure your build produces the `.skein/build` artifact the Dockerfile expects
(`skein build`).

## 2. Provision Postgres + Key Value

Create a **Postgres** instance and a **Key Value** instance from the dashboard, in the same region as
the web service. Render's Postgres supports pgvector, so semantic search works if you set
`store.index`.

Set the Key Value instance's maxmemory policy to **`noeviction`** — BullMQ's job data must not be
evicted.

## 3. Deploy the web service

Create a **Web Service** with runtime **Docker**, set **Health Check Path** to `/ok`, and add the two
environment variables using the internal connection strings.

Or declare the whole stack as a blueprint:

```yaml
# render.yaml
services:
  - type: web
    name: skein-app
    runtime: docker
    dockerfilePath: ./Dockerfile
    healthCheckPath: /ok
    envVars:
      - key: POSTGRES_URI
        fromDatabase:
          name: skein-postgres
          property: connectionString
      - key: REDIS_URI
        fromService:
          type: keyvalue
          name: skein-kv
          property: connectionString
      - key: PG_POOL_MAX
        value: "5"
      - key: SKEIN_RUN_CONCURRENCY
        value: "5"

databases:
  - name: skein-postgres
    plan: basic-256mb
```

Render injects `PORT` and skein binds it, so there is nothing to configure there.

## 4. Verify

Run the [verification sequence](./deploy.md#verify-a-deployment) against your
`https://skein-app.onrender.com` URL.

## Render caveats

### Free instances spin down — background runs won't survive

A free web service is suspended after ~15 minutes without traffic. skein's background runs execute
_after_ the request returns, so a suspended instance freezes them. Use a paid instance type for
anything that enqueues background runs, webhooks, or long-running work.

Inline runs (`/runs/wait`, `/runs/stream`) do their work during the request and are unaffected —
though the first request after a spin-down pays skein's full [cold start](./deploy.md#cold-starts) on
top of Render's.

### Use internal connection strings

The internal URLs keep database traffic off the public internet and out of your bandwidth budget. If
you must use an external Postgres URL with a self-signed certificate, set
`DATABASE_SSL_NO_VERIFY=true`.

### Streaming

Render does not buffer responses, so SSE works. Since skein sends no heartbeat frame, a long-quiet
stream can still hit an idle timeout — see
[Streaming through proxies](./deploy.md#streaming-through-proxies-sse).

### Scaling

More than one instance is fine with Postgres + Redis configured: cross-instance cancellation and the
per-thread run guard both hold. See
[Scaling past one instance](./deploy.md#scaling-past-one-instance) for the connection budget it implies.
