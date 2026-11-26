# Deploy on Render

**Postgres and Redis are required for Skein’s standard production server.** On Render, use
Render Postgres and Key Value alongside a web service that runs your prebuilt Skein image.

Everything platform-agnostic — environment variables, pool sizing, probes, scaling caveats — is in
[deploy.md](./deploy.md).

## Before you start

A Render account and a container registry Render can pull from. To use the Blueprint below, keep
`render.yaml` in a Git repo connected to Render.

<span id="1-commit-the-dockerfile"></span>
<span id="_1-commit-the-dockerfile"></span>

## 1. Build and push the image

Sign in to the registry. From the graph project directory, build and push your image. Replace the
example registry path with your own:

```bash
export DOCKER_DEFAULT_PLATFORM=linux/amd64
IMAGE=ghcr.io/your-org/skein-app:v1
skein build -t "$IMAGE"
docker push "$IMAGE"
```

## 2. Provision Postgres + Key Value

1. In the Dashboard, choose **New → Postgres**. Select the web service’s region and copy the
   **Internal Database URL** from **Connect**. Skein sets up the schema at boot. Render Postgres
   provides pgvector if you enable semantic search with `store.index`.
2. Choose **New → Key Value** in the same region and workspace. Choose a paid instance with
   persistence for production, select **`noeviction`** as the maxmemory policy, and copy the
   **Internal URL** from **Connect**. Keep external access disabled.

[Render Postgres](https://render.com/docs/postgresql-creating-connecting) ·
[Render Key Value](https://render.com/docs/key-value)

## 3. Deploy the web service

Choose **New → Web Service → Existing Image** and enter the image tag. Select the same region
and workspace as both databases, set **Health Check Path** to `/ok`, and map the Postgres Internal
Database URL to `POSTGRES_URI` and the Key Value Internal URL to `REDIS_URI`. Add any model or
tool secrets the graph needs. [Deploying an image on Render](https://render.com/docs/deploying-an-image)

Alternatively, deploy all three services with a [Blueprint](https://render.com/docs/blueprint-spec).
Replace `image.url` with the image you pushed. This example uses paid plans in Oregon and restricts
both databases to internal access. Configure registry credentials if the image is private.

```yaml
# render.yaml
services:
  - type: web
    name: skein-app
    runtime: image
    image:
      url: ghcr.io/your-org/skein-app:v1
    region: oregon
    plan: 0.5c-512mb
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
  - type: keyvalue
    name: skein-kv
    region: oregon
    plan: 256mb
    maxmemoryPolicy: noeviction
    persistenceMode: journal-snapshot
    ipAllowList: []

databases:
  - name: skein-postgres
    region: oregon
    plan: 0.1c-256mb
    ipAllowList: []
```

Render injects `PORT` and skein binds it, so there is nothing to configure there.

## 4. Verify

Configure [application auth](./deploy.md#5-auth--read-this-before-you-expose-it) before accepting
public traffic. Run the [verification sequence](./deploy.md#verify-a-deployment) against your
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

The internal URLs keep database traffic on Render’s private network. If you enable Key Value
authentication for internal connections, use the authenticated internal URL. For external
connections, follow the service’s published TLS settings.

### Streaming

Render does not buffer responses, so SSE works. Since skein sends no heartbeat frame, a long-quiet
stream can still hit an idle timeout — see
[Streaming through proxies](./deploy.md#streaming-through-proxies-sse).

### Scaling

More than one instance is fine with Postgres + Redis configured: cross-instance cancellation and the
per-thread run guard both hold. See
[Scaling past one instance](./deploy.md#scaling-past-one-instance) for the connection budget it implies.
