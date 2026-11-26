# Deploy on Google Cloud Run

**Postgres and Redis are required for Skein’s standard production server.** This guide provisions
Cloud SQL for PostgreSQL and Memorystore for Redis, then connects both to Cloud Run.

Cloud Run runs your container, scales it, and bills per request — a good fit for skein, with **one
sharp edge**: by default Cloud Run throttles a container's CPU to near-zero between requests, and
skein's background runs do their work _after_ the request that created them has returned. Get that
setting wrong and inline runs work perfectly while background runs mysteriously never finish.

Everything platform-agnostic — environment variables, pool sizing, probes, scaling caveats — is in
[deploy.md](./deploy.md).

## Before you start

You need the `gcloud` CLI authenticated, a project with billing enabled, and Docker. Enable the APIs
once:

```bash
export PROJECT_ID=your-project REGION=us-central1 REPO=skein SERVICE=skein-app
gcloud config set project $PROJECT_ID
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com sqladmin.googleapis.com redis.googleapis.com \
  compute.googleapis.com iam.googleapis.com
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

<span id="provision-postgres-and-redis"></span>

## 2. Provision Postgres + Redis

1. In **Cloud SQL → Create instance**, choose **PostgreSQL** and use the same region as Cloud Run.
   For the built-in Cloud Run socket connection below, enable a public IP and leave authorized
   networks empty. Cloud Run reaches it through the Cloud SQL Auth Proxy. Create a database and a
   password-authenticated role that owns it. If `store.index` is enabled, ensure the database
   supports pgvector and enable it with a privileged role if the app role cannot. Copy the
   **instance connection name** (`PROJECT:REGION:INSTANCE`). Use this format for `POSTGRES_URI`,
   with the actual database name and URL-encoded credentials:

   ```text
   postgresql://USER:PASSWORD@/DATABASE?host=/cloudsql/PROJECT:REGION:INSTANCE
   ```

   [Create a Cloud SQL instance](https://docs.cloud.google.com/sql/docs/postgres/create-instance) ·
   [Cloud Run socket and private IP options](https://docs.cloud.google.com/sql/docs/postgres/connect-run)

2. Choose a VPC and a subnet in the Cloud Run region for Direct VPC egress. Set `VPC_NETWORK`
   to that network name and create a non-sharded Memorystore for Redis instance with AUTH and
   eviction disabled:

   ```bash
   gcloud redis instances create skein-redis --region="$REGION" \
     --network="$VPC_NETWORK" --tier=standard --size=1 --redis-version=redis_7_2 \
     --enable-auth --redis-config=maxmemory-policy=noeviction
   gcloud redis instances describe skein-redis --region="$REGION" --format='value(host,port)'
   ```

   Get the AUTH string from the instance details or with
   `gcloud redis instances get-auth-string skein-redis --region="$REGION"`. For this
   private TCP configuration, use `redis://:URL_ENCODED_AUTH_STRING@HOST:PORT`. If you enable
   in-transit encryption, use `rediss://` and configure the provider’s CA trust in the container.

   [Connect Memorystore to Cloud Run](https://docs.cloud.google.com/memorystore/docs/redis/connect-redis-instance-cloud-run) ·
   [Supported Redis settings](https://docs.cloud.google.com/memorystore/docs/redis/supported-redis-configurations)

### Store the URLs and grant runtime access

Load both URLs into your shell without committing them. Create a dedicated service account,
grant it Cloud SQL Client, and give it access to the two Secret Manager secrets:

```bash
RUNTIME_SA="skein-runtime@$PROJECT_ID.iam.gserviceaccount.com"
gcloud iam service-accounts create skein-runtime
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_SA" --role=roles/cloudsql.client

printf '%s' "$POSTGRES_URI" | gcloud secrets create skein-postgres-uri --data-file=-
printf '%s' "$REDIS_URI" | gcloud secrets create skein-redis-uri --data-file=-
for secret in skein-postgres-uri skein-redis-uri; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:$RUNTIME_SA" --role=roles/secretmanager.secretAccessor
done
```

The identity deploying Cloud Run also needs permission to act as the runtime service account.
Add graph credentials using the same Secret Manager integration. [Cloud Run secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets)

## 3. Deploy

Set `INSTANCE_CONNECTION_NAME`, `VPC_NETWORK`, and `VPC_SUBNET` to the values from the previous step.

```bash
gcloud run deploy "$SERVICE" \
  --image="$IMAGE" \
  --region="$REGION" \
  --port=8123 \
  --execution-environment=gen2 \
  --service-account="$RUNTIME_SA" \
  --add-cloudsql-instances="$INSTANCE_CONNECTION_NAME" \
  --network="$VPC_NETWORK" --subnet="$VPC_SUBNET" --vpc-egress=private-ranges-only \
  --set-secrets=POSTGRES_URI=skein-postgres-uri:latest,REDIS_URI=skein-redis-uri:latest \
  --set-env-vars=PG_POOL_MAX=5,SKEIN_RUN_CONCURRENCY=5 \
  --no-cpu-throttling \
  --min-instances=1 \
  --max-instances=3 \
  --cpu=1 --memory=1Gi \
  --timeout=3600 \
  --no-allow-unauthenticated
```

If you use externally hosted services with publicly reachable endpoints, use their direct Postgres
and native Redis TCP URLs in Secret Manager. Omit the Cloud SQL attachment and VPC flags when
neither endpoint requires them.

The flags that matter, and why:

| Flag                                        | Why                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `--port=8123`                               | Cloud Run injects `PORT`, and skein binds it. This tells Cloud Run which port to _send_ traffic to.     |
| `--no-cpu-throttling` + `--min-instances=1` | **Required for background runs.** See [below](#background-runs-need-cpu-outside-requests).              |
| `--timeout=3600`                            | The ceiling on a streaming SSE run; skein imposes none of its own.                                      |
| `--no-allow-unauthenticated`                | skein's auth is off by default — see [the warning](./deploy.md#5-auth--read-this-before-you-expose-it). |
| `PG_POOL_MAX=5`                             | Three pools per instance × instances vs. your database's cap ([budget](./deploy.md#connection-budget)). |

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

Each instance opens three Postgres pools, so a burst to `--max-instances=10` with `PG_POOL_MAX=10`
can use up to 300 connections. Size both limits against your database’s
[connection budget](./deploy.md#connection-budget).

### Shutdown

Cloud Run sends `SIGTERM` and gives the container 10 seconds before `SIGKILL`. Keep Skein’s
default 5-second drain window to leave time for aborting the remaining runs and closing the
database connections. [Cloud Run shutdown contract](https://docs.cloud.google.com/run/docs/container-contract#instance-shutdown)

Note that Cloud Run has no `init` process. The image is fine as-is, but if your graphs spawn child
processes you'll want `tini` — add it via `dockerfile_lines` in `langgraph.json`.

### Multi-instance semantics

With `--max-instances` above 1 and Postgres + Redis configured, cross-instance cancellation and the
one-run-per-thread guard both hold — no session affinity needed. See
[Scaling past one instance](./deploy.md#scaling-past-one-instance) for what that costs in Postgres
connections.
