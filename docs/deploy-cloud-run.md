# Deploy on Google Cloud Run

Cloud Run runs your container, scales it, and bills per request — a good fit for skein, with **one
sharp edge**: by default Cloud Run throttles a container's CPU to near-zero between requests, and
skein's background runs do their work _after_ the request that created them has returned. Get that
setting wrong and inline runs work perfectly while background runs mysteriously never finish.

Everything platform-agnostic — environment variables, pool sizing, probes, scaling caveats — is in
[deploy.md](./deploy.md).

## Contents

- [Before you start](#before-you-start)
- [1. Build and push the image](#1-build-and-push-the-image)
- [2. Provision Postgres + Redis](#2-provision-postgres--redis)
- [3. Deploy](#3-deploy)
- [4. Verify](#4-verify)
- [Cloud Run caveats](#cloud-run-caveats)

## Before you start

You need the `gcloud` CLI authenticated, a project with billing enabled, and Docker. Enable the APIs
once:

```bash
export PROJECT_ID=your-project REGION=us-central1 REPO=skein SERVICE=skein-app
gcloud config set project $PROJECT_ID
gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
```

## 1. Build and push the image

```bash
# Cloud Run runs x86. skein build doesn't pass --platform, so set this on Apple Silicon.
export DOCKER_DEFAULT_PLATFORM=linux/amd64
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$SERVICE:v1

gcloud artifacts repositories create $REPO --repository-format=docker --location=$REGION
gcloud auth configure-docker $REGION-docker.pkg.dev

skein build -t $SERVICE
docker tag $SERVICE $IMAGE
docker push $IMAGE
```

## 2. Provision Postgres + Redis

Anything reachable works. Two shapes are common:

**Managed outside GCP** (Neon, Supabase, Upstash, Redis Cloud) — simplest, no VPC needed, and the
connection strings work as-is. Use the **direct** Postgres endpoint, not a pooled one
([why](./deploy.md#tls-to-the-database)).

**GCP-native** — Cloud SQL and Memorystore:

- **Cloud SQL** attaches over a Unix socket, which needs no TLS configuration. `POSTGRES_URI` is
  handed straight to `pg`, so the socket form works:
  ```text
  postgresql://USER:PASSWORD@/DATABASE?host=/cloudsql/PROJECT:REGION:INSTANCE
  ```
  Add `--add-cloudsql-instances=PROJECT:REGION:INSTANCE` to the deploy below.
- **Memorystore** is only reachable from inside your VPC, so the service needs Direct VPC egress or a
  Serverless VPC Access connector (`--network`/`--subnet`, or `--vpc-connector`).

Store both URIs in Secret Manager rather than passing them as plain environment variables —
`gcloud run services describe` prints env vars in cleartext:

```bash
printf '%s' "$POSTGRES_URI" | gcloud secrets create skein-postgres-uri --data-file=-
printf '%s' "$REDIS_URI"    | gcloud secrets create skein-redis-uri --data-file=-
```

Grant the service's runtime service account `roles/secretmanager.secretAccessor`.

## 3. Deploy

```bash
gcloud run deploy $SERVICE \
  --image=$IMAGE \
  --region=$REGION \
  --port=8123 \
  --set-secrets=POSTGRES_URI=skein-postgres-uri:latest,REDIS_URI=skein-redis-uri:latest \
  --set-env-vars=PG_POOL_MAX=5,SKEIN_RUN_CONCURRENCY=5 \
  --no-cpu-throttling \
  --min-instances=1 \
  --max-instances=3 \
  --cpu=1 --memory=1Gi \
  --timeout=3600 \
  --no-allow-unauthenticated
```

The flags that matter, and why:

| Flag                                        | Why                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `--port=8123`                               | Cloud Run injects `PORT`, and skein binds it. This tells Cloud Run which port to _send_ traffic to.     |
| `--no-cpu-throttling` + `--min-instances=1` | **Required for background runs.** See [below](#background-runs-need-cpu-outside-requests).              |
| `--timeout=3600`                            | The ceiling on a streaming SSE run; skein imposes none of its own.                                      |
| `--no-allow-unauthenticated`                | skein's auth is off by default — see [the warning](./deploy.md#5-auth--read-this-before-you-expose-it). |
| `PG_POOL_MAX=5`                             | Two pools per instance × instances vs. your database's cap ([budget](./deploy.md#connection-budget)).   |

Cloud Run's built-in health checking uses the container port; you can also declare an explicit
startup probe on `GET /ok` with a ~30s failure budget, since boot runs migrations before listening.

## 4. Verify

With `--no-allow-unauthenticated`, reach the service through an authenticated tunnel rather than
opening it up:

```bash
gcloud run services proxy $SERVICE --region=$REGION --port=8123
```

Then run the [verification sequence](./deploy.md#verify-a-deployment) against `http://localhost:8123`.
Step 4 — the background run — is the one that proves the CPU settings are right.

## Cloud Run caveats

### Background runs need CPU outside requests

This is the big one. `POST /threads/{id}/runs` enqueues a run and responds immediately; the
worker executes it afterwards. Under Cloud Run's default _CPU-allocated-during-requests_ model, the
instance's CPU is throttled to near-zero the moment the response is sent, so that run stops making
progress — and with `--min-instances=0` the instance may be shut down entirely.

Set **`--no-cpu-throttling`** (CPU always allocated) and **`--min-instances=1`**. This costs more —
you're paying for an always-on vCPU rather than per-request — but it's what makes background runs,
webhooks and cron-shaped work behave.

If you only use inline runs (`/runs/wait`, `/runs/stream`), the work happens _during_ the request and
the defaults are fine. Scale to zero freely.

### Request timeout vs. streaming

Default 300s, max 3600s. A long SSE run is a long request. skein sends no heartbeat frame, so a
stream that goes quiet still counts against the timeout — set `--timeout` to cover your worst case.
Don't put Cloud CDN in front of the streaming routes; it buffers.

### Connections vs. autoscaling

Each instance opens two Postgres pools, so a burst to `--max-instances=10` with `PG_POOL_MAX=10`
wants 200 connections. Cap `--max-instances`, keep `PG_POOL_MAX` small, or front Cloud SQL with the
Auth Proxy or a pooler.

### Shutdown

Cloud Run sends `SIGTERM` and SIGKILLs 10 seconds later by default. skein drains in-flight runs for
5s, aborts the rest so they land in a terminal status, and exits — comfortably inside that window. If
you raise `SKEIN_SHUTDOWN_GRACE_MS`, raise Cloud Run's termination grace period to match, or you'll
be killed mid-drain.

Note that Cloud Run has no `init` process. The image is fine as-is, but if your graphs spawn child
processes you'll want `tini` — add it via `dockerfile_lines` in `langgraph.json`.

### Multi-instance semantics

With `--max-instances` above 1 and Postgres + Redis configured, cross-instance cancellation and the
one-run-per-thread guard both hold — no session affinity needed. See
[Scaling past one instance](./deploy.md#scaling-past-one-instance) for what that costs in Postgres
connections.
