# Deploy anywhere

**Deploy your LangGraph.js graphs anywhere you can run a container.** skein has no `skein deploy` and
no control plane — that's the point ([roadmap.md](./roadmap.md) lists it as an explicit non-goal).
What it ships instead is an ordinary OCI image: `skein build` bundles your TypeScript graphs to plain
JS and produces a Docker image that needs a Postgres, a Redis, and two environment variables. Nothing
about it is specific to any host.

Production artifacts can run on Node, Bun, or Deno. Node 24 LTS is the default and uses Express. Bun and
Deno use the Web-standard `@skein-js/fetch` adapter and their native HTTP servers. Select one in
`langgraph.json` or at build time:

Node is the graduated production fallback. Bun and Deno are preview targets until each complete
clean-image conformance matrix (real SDK, Postgres/Redis, multi-instance streaming, slow clients,
telemetry parenting, and PID-1 shutdown) is green; the native launchers themselves are tested.

```json
{ "skein": { "runtime": { "name": "deno", "version": "2.9.4" } } }
```

```bash
skein build --runtime bun --runtime-version 1.3.14 -t my-agent
```

CLI flags override config. The image pins the official runtime image, imports every graph under that
runtime during the build, starts the runtime directly as PID 1, and uses a non-root user. Deno gets
explicit network, environment, artifact-read, system, and native-library permissions. Skein cannot
make an arbitrary Node-native graph dependency portable; the compatibility probe fails that image
build so the dependency can be replaced or isolated before deployment.

This page is everything that is true on **every** platform. The per-platform guides are just the
dashboard and CLI steps on top of it.

## Contents

- [Pick a platform](#pick-a-platform)
- [What the image already does for you](#what-the-image-already-does-for-you)
- [What every deployment needs](#what-every-deployment-needs)
- [Sizing & tuning](#sizing--tuning)
- [Scaling past one instance](#scaling-past-one-instance)
- [Streaming through proxies (SSE)](#streaming-through-proxies-sse)
- [Verify a deployment](#verify-a-deployment)
- [Environment variables](#environment-variables)

## Pick a platform

| Platform                                       | Deploy from                     | Postgres + Redis                       | Background runs                                      | Scales to zero                          | Stop-signal window                  |
| ---------------------------------------------- | ------------------------------- | -------------------------------------- | ---------------------------------------------------- | --------------------------------------- | ----------------------------------- |
| [Google Cloud Run](./deploy-cloud-run.md)      | push image to Artifact Registry | Cloud SQL + Memorystore, or any hosted | ⚠️ needs `--no-cpu-throttling` + `--min-instances=1` | yes — queued runs stall until a request | 10s default, configurable           |
| [Railway](./deploy-railway.md)                 | Dockerfile in repo              | Railway plugins                        | ✅ default                                           | no                                      | ~30s                                |
| [Fly.io](./deploy-fly.md)                      | Dockerfile in repo              | Fly Postgres / Upstash Redis           | ⚠️ needs `min_machines_running = 1`                  | yes, if auto-stop is on                 | `kill_timeout` (5s default)         |
| [Render](./deploy-render.md)                   | Dockerfile or image             | Render Postgres + Key Value            | ⚠️ paid instance (free ones spin down)               | free tier only                          | ~30s                                |
| [AWS App Runner](./deploy-aws.md#app-runner)   | push image to ECR               | RDS + ElastiCache                      | ⚠️ CPU throttled between requests                    | no (min 1 instance)                     | ~30s                                |
| [AWS ECS Fargate](./deploy-aws.md#ecs-fargate) | push image to ECR               | RDS + ElastiCache                      | ✅ default                                           | no                                      | `stopTimeout` (30s default)         |
| [Kubernetes](./deploy-kubernetes.md)           | push image to any registry      | whatever you run                       | ✅ default                                           | no (unless KEDA/Knative)                | `terminationGracePeriodSeconds` 30s |
| [VPS / plain Docker](./deploy-vps.md)          | build on the box or pull        | containers or managed                  | ✅ default                                           | no                                      | `docker stop -t` (10s default)      |
| [Vercel & serverless](./deploy-serverless.md)  | n/a — not a container           | any hosted                             | ❌ not supported                                     | yes                                     | none                                |

> **How these were verified.** The image contract itself — port binding, the `/ok` probe, `SIGTERM`
> draining in-flight runs to a terminal status, Postgres migrations on boot — was exercised
> end-to-end against real Postgres and Redis containers, and the behaviors described below are what
> was actually observed. The individual platform guides apply that same contract using each
> platform's own documentation; they have not each been deployed for real. If a step is wrong on your
> platform, please [open an issue](https://github.com/skein-js/skein-js/issues) — corrections to
> these are very welcome.

## What the image already does for you

`skein build` produces the image; `skein dockerfile` prints the same Dockerfile if you'd rather commit
it and let your platform build it. Either way:

- **Binds the port the platform gives it.** The CMD passes no `--port`, so the server binds `$PORT`
  when one is injected (Railway, Render, Cloud Run and AWS App Runner all do). When nothing is
  injected it falls
  back to **8123** — the same port the image `EXPOSE`s and health-checks — so a bare
  `docker run -p 8123:8123` works, as do platforms that route to a port you declare without setting
  `PORT` for you (Fly.io, ECS, Kubernetes).
- **Handles `SIGTERM` properly.** The selected runtime is PID 1 (the CMD invokes it directly, not through
  `npx` — under `npx`, PID 1 is npm, which exits on `SIGTERM` without waiting for the server). On
  signal, skein stops accepting queued runs, gives in-flight runs
  [a grace window](#graceful-shutdown) to finish, aborts whatever is left so it lands in a **terminal**
  status rather than stranded as `running`, then closes the pools.
- **Serves a health probe** at `GET /ok` → `200 {"ok":true}`, and declares a Docker `HEALTHCHECK`
  against it with a 20s start period.
- **Runs unprivileged** as the runtime image's `node`, `bun`, or `deno` user.
- **Reads config from the environment only** — `POSTGRES_URI` and `REDIS_URI`. The generated
  `.dockerignore` excludes `.env*` and `.npmrc*`, so secrets are never baked into a layer.
- **Installs pinned production dependencies only.** No vite/tsx, no devDependencies, no runtime
  TypeScript transform: `skein build` resolved your tsconfig `paths` and workspace aliases once, on the
  host. Source maps stay on, so stack traces still point at your TypeScript.
  The pinned set is **derived from the bundle**: every published package your graphs still import
  after bundling is recorded at the exact version installed on the build host, and `skein build` fails
  on the host if the two ever disagree. Packages you load **by name at runtime** are the exception a
  bundler cannot see — declare those under `dependencies` in `langgraph.json`
  ([what `skein build` bundles](./bundling.md#what-skein-build-inlines-vs-externalizes)).
- **Caches dependency installs** via a BuildKit cache mount, and accepts an optional `id=npmrc` build
  secret for private scoped packages — `skein build --npmrc <path>`, or
  `docker build --secret id=npmrc,src=$HOME/.npmrc` for the standalone Dockerfile. See
  [langgraph-cli-compat.md](./langgraph-cli-compat.md).

**Migrations run automatically on boot.** There is no `skein migrate` step. On startup skein applies
its schema (tracked in a `skein_migrations` table), sets up LangGraph's checkpoint tables, registers
one assistant per declared graph, and — because `skein start` warms graphs — imports every graph
module. All of that finishes _before_ the server starts listening. Migrations take their own advisory
lock, so several instances booting at once during a rolling deploy is safe — the ones that don't win
the lock **wait**, then find nothing to apply.

That covers **both** schemas, on two separate lock keys: skein's own, and LangGraph's checkpoint
tables. The second one is skein's lock around someone else's migration —
`PostgresSaver.setup()` in `@langchain/langgraph-checkpoint-postgres` reads its version ledger and
then creates types and inserts rows with no exclusion of its own, so concurrent boots against a
database with pending migrations collide on `checkpoint_migrations_pkey` or `pg_type`. Separate keys
because the two schemas are independent: sharing one would make every boot wait on a migration it
does not depend on. It only bites when migrations are genuinely pending — a first deploy, or an
upgrade that bumps that package's schema — which is exactly when replicas start together.

> **Building on Apple Silicon?** `skein build` doesn't pass `--platform`, so you'll get an arm64 image
> that most hosts reject. Export `DOCKER_DEFAULT_PLATFORM=linux/amd64` before building.

## What every deployment needs

### 1. A Postgres

Set `POSTGRES_URI`. It holds protocol resources (assistants, threads, runs, store items) and
LangGraph checkpoints. The base schema needs **no extensions**.

pgvector is needed **only if you set `store.index` in `langgraph.json`** for semantic search. skein
runs `CREATE EXTENSION IF NOT EXISTS vector` on boot, which can only enable an extension the server
already has — it cannot install one. If it's missing, boot fails with an error telling you so.

| Provider            | pgvector available                                         |
| ------------------- | ---------------------------------------------------------- |
| Cloud SQL (PG 13+)  | ✅ (`vector` is a supported extension)                     |
| AWS RDS (PG 15+)    | ✅                                                         |
| Neon                | ✅                                                         |
| Supabase            | ✅ (enabled by default)                                    |
| Render Postgres     | ✅                                                         |
| Railway             | ⚠️ use the **pgvector template**, not the default Postgres |
| `postgres:16` image | ❌ — use `pgvector/pgvector:pg16`                          |

### 2. A Redis

Set `REDIS_URI`. skein uses it for the run queue (BullMQ) and for cross-instance stream pub/sub with
replay. Configure the instance with `maxmemory-policy noeviction` — BullMQ's job data must not be
evicted.

**The image requires it, and so does the entrypoint.** Its CMD runs
`skein start --store postgres --queue redis` — but those are also `skein start`'s own defaults now, and
it _rejects_ `--store memory` / `--queue memory` outright. Overriding the CMD, or running the binary by
hand, can no longer produce a production server whose queue is process-local and whose state disappears
on restart. The redis
queue driver fails the boot if `REDIS_URI` is unset. (Redis is only _optional_ on the in-code
embedding path — `embedPostgresGraphs` falls back to an in-memory queue and bus when no Redis URL is
given, which keeps state durable but limits you to a single instance. See
[embedding.md](./embedding.md#going-to-production).)

### 3. The port

Nothing to do if your platform injects `PORT`. If it asks you which port the container listens on,
answer **8123**.

### 4. A health probe

Point it at **`/ok`**. It's a dependency-free liveness check that deliberately does _not_ touch
Postgres or Redis, so a transient database blip can't flap an otherwise healthy instance.

It also works as a **startup/readiness probe**: migrations, assistant registration and graph warming
all complete before the server binds, so a responding `/ok` genuinely means "fully booted". Budget
your startup probe accordingly — the image's own estimate is 20 seconds.

### 5. Auth — read this before you expose it

> ⚠️ **skein's auth is off by default, and this is the production path.** With no `auth.path`
> configured in `langgraph.json`, every protocol endpoint is open: anyone who can reach the URL can
> create threads, run your graphs, and spend your model-provider tokens. Either configure auth (see
> [agent-protocol.md](./agent-protocol.md) for the route→permission map) or keep the service private —
> behind your platform's authenticated ingress, a VPC, or an authenticating proxy.
>
> `/ok` is registered ahead of the auth engine, so health probes keep working either way.

## Sizing & tuning

### Connection budget

skein opens **three** Postgres pools per instance: one for protocol resources, one for LangGraph's
`PostgresSaver`, and one for the per-thread execution claim (see
[Scaling past one instance](#scaling-past-one-instance)). All three are capped by `PG_POOL_MAX`, so plan
for:

```text
max connections ≈ 3 × PG_POOL_MAX × instances
```

Check that against your database's limit — this is the most common way to exhaust a small managed
Postgres once autoscaling kicks in. `PG_POOL_MAX=5` is a sane starting point.

The execution-claim pool behaves differently from the other two, and it is worth knowing how: a
connection is held for the **whole duration** of an executing run, not for the length of a query. So its
working size is your run concurrency, not your request rate — and it is sized from
`SKEIN_RUN_CONCURRENCY` plus headroom for the inline run modes (`/runs/wait`, `/runs/stream`,
`/threads/{id}/stream`, `/threads/{id}/commands`), which execute without consuming a worker slot and are
therefore bounded by request arrival rather than by run concurrency.

Past that headroom an inline run waits for a free claim connection and then **fails** rather than
executing unguarded — the safe direction, since executing without the claim is what interleaves two runs'
checkpoint writes. Keep `PG_POOL_MAX` at or above run concurrency (`skein start` warns at boot when it is
not), and raise it if you serve heavy concurrent streaming alongside a saturated background worker.

### When the database stops answering

`pg` waits for a pool connection **forever** by default, which turns an unreachable database into a
**hang** rather than an error: no status code, no log line, just a socket the client eventually
abandons. skein applies a 30s `PG_CONNECTION_TIMEOUT_MS` so the fault surfaces.

Thirty rather than something tighter, because `pg` uses that one timer for two different waits — the
connection handshake **and** waiting for a free client when the pool is already at `PG_POOL_MAX`. A
tight bound therefore fails two ordinary situations: a burst of slow-but-working queries against a
small pool, and an autosuspended serverless Postgres (Neon, Supabase) waking up, which regularly takes
longer than ten seconds and happens on the boot path. Set `PG_CONNECTION_TIMEOUT_MS=0` for `pg`'s
original wait-forever behaviour.

`PG_STATEMENT_TIMEOUT_MS` bounds a single statement server-side — the last line of defence against one
pathological query pinning a pool connection. **On by default at 30s**; `0` disables it. It is per
_statement_, not per request, so a legitimately long sequence of quick queries is unaffected; what it
catches is one query that is stuck or scanning something it shouldn't. Suggested 15000 on a small
instance, 60000 on a large one.

It became a default only once the list/search paths were page-bounded and indexed — before that it would
have turned slow-but-working queries into errors. If your deployment has a query that genuinely runs
longer, raise it or set `0`; a cancelled statement surfaces as a `57014` error naming the statement,
rather than as a hang. The shapes that can still take a while, all of them either bounded by you or
inherently large: a deep `OFFSET`, an unindexed `values` filter, `POST /store/namespaces`
(`SELECT DISTINCT` over the store), store search by text with no `store.index` configured (a whole-table
read by design), and anything that walks a very large thread's whole checkpoint history — copying a
thread, or a `multitask_strategy: "rollback"` on one. Rollback in particular reports a failure as a
warning and continues, so on very large threads either raise the timeout or prefer another strategy.

Schema DDL is exempt, and deliberately so: our migrations and the pgvector setup lift the timeout on
their own connection, and the checkpointer's `setup()` runs on a separate untimed pool. Index builds are
legitimately slow, a cancelled `CREATE INDEX CONCURRENTLY` leaves an _invalid_ index that the retry skips
by name (recording the migration as applied while the index goes permanently unused), and a cancelled
boot migration is a boot _loop_ rather than a slow boot. Those connections are destroyed rather than
returned to the pool, so the lifted timeout can't leak into a later query that happens to reuse them.

It is applied with a `SET` on each new connection rather than as a startup parameter, because
PgBouncer and Supabase's pooler reject unrecognised startup parameters outright. Under **transaction**
pooling a `SET` does not persist, so the timeout silently does not apply there — it is a backstop, not
a guarantee.

**Full sizing guidance, and every tuning knob in one table, is in
[performance.md](./performance.md).** This section covers only what is specific to running the
container.

### Heap size vs. the container's memory limit

The image bakes **no** `--max-old-space-size`, because a Dockerfile cannot know the limit the container
will be given. Instead `skein start` compares the two at boot and warns when V8's ceiling is above ~75% of
the container's limit, naming the flag and a computed value.

Node **is** cgroup-aware — since v12 it sizes the heap from the container's limit, not the host's — so the
usual advice to set `--max-old-space-size` on every container is wrong here, and following it can make
things worse. Measured on `node:22-slim`, V8's ceiling tracks about half the limit: 512Mi → 259MB,
1Gi → 524MB, 2Gi → 1048MB. Setting it to "75% of the limit" on a 512Mi container would _raise_ the heap
from 259MB to 432MB and make an OOM kill more likely, not less.

What the automatic sizing does not do is go below a floor of about **259MB**. So under roughly 345Mi —
256Mi and 128Mi are ordinary Cloud Run and Kubernetes settings — V8's ceiling meets or exceeds the whole
container, it never feels the pressure that would trigger a full GC, and the kernel kills the process
first. That appears as a restart with no stack, no log line, and nothing in your metrics.

**Only act on this when the warning fires**, and then lower the heap rather than raising it. The warning
names a computed value. Include the image's own flag when you set it — `NODE_OPTIONS` replaces the
image's value rather than adding to it, so omitting `--enable-source-maps` silently costs you TypeScript
stack traces:

```
NODE_OPTIONS="--enable-source-maps --max-old-space-size=153"
```

`skein start` also warns when run concurrency exceeds `PG_POOL_MAX`, for the same reason: runs then queue
waiting for a connection rather than executing, which looks like flat throughput rather than like a pool
limit. Budget **two** pools per instance (store + checkpointer).

### Heap pressure while running

Separately from the boot check, skein samples heap usage every 30s and warns once when it passes 85% of
the limit — then stays quiet until it drops back below 70%, so a sustained episode is one log line rather
than one every 30 seconds. It runs for the life of the background worker and needs a `logger` to be
configured; `SKEIN_HEAP_WARN_PERCENT=0` turns it off.

The warning carries what makes it actionable, because the percentage alone does not:

| What the line shows                                | What it means                                                                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| High `runs in flight`, at or near your concurrency | Too much work at once — lower `SKEIN_RUN_CONCURRENCY` or scale out.                                                    |
| High `buffered frames`                             | A slow SSE consumer is holding a run's frames in memory — see `SKEIN_MEMORY_BUS_MAX_FRAMES_PER_RUN`, or move to Redis. |
| Neither, and the heap stays high across episodes   | A genuine leak. Capture a heap snapshot.                                                                               |

On Redis there is no `buffered frames` figure, because the frames are not in this process's heap — which
is itself part of the answer.

Two limits worth knowing. It watches the **JS heap only**: `used_heap_size` excludes external memory, so
a process killed for RSS — large `Buffer`s, many sockets — never trips it. That is the right scope for
what skein itself retains (buffered frames, mirrored graph state), but it does not make the boot check
above redundant. And the re-arm band sits 15 points under whatever threshold you set, so
`SKEIN_HEAP_WARN_PERCENT=60` re-arms at 45%; a value at or below 15 latches after its first warning for
the life of the process, which is the safe direction rather than a flood.

### Run concurrency

Each instance executes up to **10** queued runs at once. Set `SKEIN_RUN_CONCURRENCY` (or the
LangGraph-compatible `N_JOBS_PER_WORKER`) to change it. Every in-flight run draws from both pools
above, so `concurrency × instances` is the number to budget against the connection cap. Prefer more
instances over higher concurrency when runs are CPU-bound. See
[runs-and-redis.md](./runs-and-redis.md#run-concurrency) for head-of-line-blocking behavior.

The environment variable is validated even when the flag is also passed, so a typo fails the boot
loudly instead of silently reverting to the default.

### TLS to the database

A URL with `?sslmode=require` and a real CA chain needs nothing extra — `pg` honors `sslmode`. For a
database presenting a self-signed certificate, set `DATABASE_SSL_NO_VERIFY=true`. Over a private
network (Railway's `*.railway.internal`, a VPC, a Unix socket) you need neither.

If your provider offers a **pooled** connection endpoint (PgBouncer and friends), use the **direct**
endpoint instead. Boot migrations take a session-level advisory lock, which transaction-mode pooling
does not preserve.

### Graceful shutdown

On `SIGTERM` skein stops pulling from the queue, waits `SKEIN_SHUTDOWN_GRACE_MS` (default **5000**)
for in-flight runs to finish, then aborts the stragglers so they settle to a terminal status, closes
the pools, and exits. If that whole sequence hasn't finished 3 seconds after the grace window, the
process force-exits anyway — so the default worst case is ~8s, which fits inside the tightest common
kill window.

Raise the grace window where the platform allows a longer one, and keep it below what the platform
actually grants — past that, you're just being SIGKILLed mid-drain:

| Platform      | Window between SIGTERM and SIGKILL        |
| ------------- | ----------------------------------------- |
| Cloud Run     | 10s default, configurable                 |
| Railway       | ~30s                                      |
| Fly.io        | `kill_timeout` in `fly.toml` (5s default) |
| Render        | ~30s                                      |
| ECS           | `stopTimeout` (30s default, 120s max)     |
| Kubernetes    | `terminationGracePeriodSeconds` (30s)     |
| `docker stop` | `-t` (10s default)                        |

Runs that get aborted are marked terminal, not lost: with Redis, BullMQ's stalled-job recovery
re-delivers a job whose worker died, and the worker skips any run already in a terminal state.

**Embedding skein in your own server instead of using `skein start`?** You get no signal handling —
wire it yourself: `process.on("SIGTERM", …)` → `runtime.worker.stop()` → dispose. Drain first, dispose
second; disposing while runs are still draining pulls the store out from under them.

### Cold starts

Boot does real work: schema migrations, `PostgresSaver` setup, one get-or-create per declared graph,
and eager-loading every graph module. Twenty seconds is a reasonable startup-probe budget. On
platforms that scale to zero, this is paid on the first request after an idle period.

## Scaling past one instance

With Postgres and Redis, replicas share state and streams — a client can join a run executing on
another instance, rolling deploys are safe, **and the run semantics hold across instances**. No session
affinity or single-instance restriction is needed for any of it:

- **Cancellation** crosses instances. `POST …/runs/{id}/cancel` routed to instance B stops a run
  executing on instance A: the run row is settled immediately (which is what makes the cancel durable),
  and the _signal to stop now_ travels over a Redis pub/sub channel to whichever instance is executing
  it. Delivery is best-effort by design — a dropped message costs promptness, never correctness.
- **One-active-run-per-thread** is decided by Postgres, not by a lock in one process:
  `multitask_strategy: "reject"` is an atomic check-and-insert, so two instances racing the same thread
  cannot both win.
- **`multitask_strategy: "enqueue"`, `"interrupt"` and `"rollback"`** all hold. A run claims its thread
  with a Postgres **session advisory lock** held for the run's duration, so a queued run waits for the
  active one wherever that one is running. The displaced run's base checkpoint and the displacing run's
  rollback plan are persisted on the runs themselves, so any instance can apply them — and a run
  recovered after a crash still cleans up what it displaced.

**Why a Postgres lock and not a Redis lease.** A run holds its claim for its whole execution, which can
be minutes. A TTL lease has to be renewed for all of it, and a late renewal — a blocked event loop, a GC
pause — expires the lease while the run is still writing, putting two instances on one thread's
checkpoint history. A session lock has no TTL: Postgres holds it until the session releases it _or the
connection dies_, so a crashed instance frees its threads at once and a slow one keeps them. This is the
same split LangGraph Platform makes (Postgres for rows and exclusivity, Redis for ephemeral pub/sub).

**Budget for it.** Each _concurrently-executing_ run holds one connection from a dedicated pool for the
run's duration — the same trade LangGraph Platform makes. See [Connection budget](#connection-budget).

The one remaining caveat is utilization, not correctness: a queued run waiting for a busy thread still
occupies a worker slot, so a burst of `enqueue` runs on one thread can crowd out other threads' work.
Tracked as per-thread partitioned dispatch on the [roadmap](./roadmap.md). See
[runs-and-redis.md](./runs-and-redis.md).

## Streaming through proxies (SSE)

skein sends `text/event-stream` with `cache-control: no-cache, no-transform` and flushes headers
immediately. Streams are **back-pressured**: a client that reads slowly is paced rather than buffered
in the server's memory, so a few hundred slow connections cost a bounded ~65 KB each instead of a full
copy of each stream — see [streaming.md](./streaming.md#slow-clients-and-backpressure). Two things it
does _not_ do, which matter in front of a proxy:

- It sends **no `X-Accel-Buffering: no` header**. A buffering reverse proxy will hold the stream
  until the run finishes, which looks exactly like a hang. Turn buffering off: nginx
  `proxy_buffering off;`, ingress-nginx `nginx.ingress.kubernetes.io/proxy-buffering: "off"`, Caddy
  `flush_interval -1`. Don't put a caching CDN in front of the stream routes.
- It sends **no heartbeat frame**. A stream that produces no tokens for a while can be culled by an
  idle timeout, so raise the proxy's read timeout to cover your longest quiet stretch.

There is also **no server-side run timeout** under `skein start` — the engine supports one
(`runTimeoutMs`), but no CLI flag or environment variable exposes it, so it is only reachable when you
[embed skein in your own server](./embedding.md). With the image, the platform's request timeout is
the only ceiling on a streaming run; set it generously (Cloud Run allows up to 60 minutes).

Clients reconnect with `Last-Event-ID` and skein replays missed frames from a Redis stream (kept for
an hour), so a dropped connection is recoverable. See [streaming.md](./streaming.md).

## Verify a deployment

Every platform guide points here. Substitute your service's base URL.

```bash
BASE=https://your-service.example.com

# 1. Liveness — the same probe your platform uses.
curl -s $BASE/ok                                    # {"ok":true}

# 2. Your graphs registered as assistants at boot.
curl -s -X POST $BASE/assistants/search \
  -H 'content-type: application/json' -d '{"limit":10}'

# 3. An inline streaming run — exercises SSE and Postgres checkpointing end to end.
THREAD=$(curl -s -X POST $BASE/threads -H 'content-type: application/json' -d '{}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).thread_id')
curl -N -X POST $BASE/threads/$THREAD/runs/stream \
  -H 'content-type: application/json' \
  -d '{"assistant_id":"agent","input":{"messages":[{"role":"user","content":"hi"}]}}'

# 4. A BACKGROUND run — the one that catches CPU-throttling platforms. It returns immediately;
#    the work happens after the request ends, which is exactly when a throttled instance freezes.
RUN=$(curl -s -X POST $BASE/threads/$THREAD/runs \
  -H 'content-type: application/json' \
  -d '{"assistant_id":"agent","input":{"messages":[{"role":"user","content":"hi"}]}}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).run_id')

# 5. Join it mid-flight (replayed from Redis), then confirm it finished.
curl -N $BASE/threads/$THREAD/runs/$RUN/stream
curl -s $BASE/threads/$THREAD/runs/$RUN | node -pe 'JSON.parse(require("fs").readFileSync(0)).status'
```

Step 4 is the one worth actually running. A background run that never leaves `pending`/`running` while
the service is idle means the platform is suspending your instance between requests — see that
platform's guide.

## Environment variables

skein reads these and nothing else. Note there is **no `DATABASE_URL` or `REDIS_URL`** — those are
platform names; map them onto skein's.

| Variable                 | Required             | Purpose                                                           |
| ------------------------ | -------------------- | ----------------------------------------------------------------- |
| `POSTGRES_URI`           | yes (postgres store) | Postgres connection string (resources + checkpoints).             |
| `REDIS_URI`              | yes (redis queue)    | Redis connection string (run queue + stream pub/sub).             |
| `PORT`                   | usually injected     | Port to bind. Defaults to 8123 — the port the image exposes.      |
| `HOST`                   | no                   | Host to bind. The image already passes `--host 0.0.0.0`.          |
| `DATABASE_SSL_NO_VERIFY` | no                   | `true` to skip TLS cert verification (self-signed database cert). |

Everything else is **tuning**, and lives in one place so the numbers can't drift apart:
**[performance.md](./performance.md#every-knob)** has every knob with its default and a suggested value
for a small (256–512Mi) and a large (1–4Gi) deployment — run concurrency, the shutdown drain, page and
stream bounds, the pool and statement timeouts, the heap monitor, and request logging.

Two notes specific to the container:

- The in-memory bus knobs (`SKEIN_MEMORY_BUS_*`) are **not** reachable from this image — `skein start`
  rejects `--queue memory`. They apply on the embedded path (`embedPostgresGraphs` with no `REDIS_URI`)
  and under `skein dev`; see [embedding.md](./embedding.md#going-to-production).
- `PG_POOL_MAX` is per pool and skein opens **three** per instance, so budget three times your setting against
  the database's own connection cap — per replica.
