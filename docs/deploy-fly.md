# Deploy on Fly.io

**Postgres and Redis are required for Skein’s standard production server.** Use Fly Managed
Postgres and Upstash Redis in the same Fly organization and primary region as the app.

Everything platform-agnostic — environment variables, pool sizing, probes, scaling caveats — is in
[deploy.md](./deploy.md).

## Before you start

Install `flyctl` and log in (`fly auth login`). Fly builds remotely by default, so you don't need
Docker locally and the architecture is handled for you.

<span id="1-commit-the-dockerfile"></span>
<span id="_1-commit-the-dockerfile"></span>

## 1. Create the app and build the artifact

```bash
APP=your-unique-skein-app
fly apps create "$APP"
skein build --artifact-only
```

Use the app name you created in `fly.toml` below. The artifact includes the bundled graphs and
Dockerfile in `.skein/build`, which Fly uses as its remote build context.

## 2. Provision Postgres + Redis

1. Run `fly mpg create` and select the app’s organization and region. In the cluster’s **Connect**
   tab, copy the **Direct URL** with the `direct.…flympg.net` hostname for `POSTGRES_URI`. The
   pooled URL uses PgBouncer. Skein needs a direct session for migrations and run locks. Managed
   Postgres ships pgvector for graphs that use `store.index`. [Fly Postgres connections](https://fly.io/docs/mpg/client-configuration/)
2. Run `fly redis create` and select the same organization and primary region. Leave eviction
   disabled. Run `fly redis status YOUR_REDIS_NAME` and copy the **Private URL** for `REDIS_URI`.
   This is the native Redis endpoint reachable from your Fly app. [Fly Redis](https://fly.io/redis/)

Load the copied URLs into your shell and stage both as app secrets. Add any model or tool secrets
your graph needs the same way.

```bash
fly secrets set --stage --app "$APP" \
  "POSTGRES_URI=$POSTGRES_URI" \
  "REDIS_URI=$REDIS_URI"
```

## 3. Configure and deploy

Save this as `fly.toml` in the graph project directory. Match the app name and region to the
resources above. Configure [application auth](./deploy.md#5-auth--read-this-before-you-expose-it)
before taking public traffic.

```toml
# fly.toml
app = "your-unique-skein-app"
primary_region = "iad"

# Allow time for Skein to drain runs on shutdown.
kill_signal = "SIGTERM"
kill_timeout = "15s"

[http_service]
  internal_port = 8123          # must match the port the app binds; see the note below
  force_https = true
  auto_stop_machines = "off"    # see the background-runs caveat below
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    grace_period = "20s"        # boot runs migrations before listening
    interval = "30s"
    timeout = "5s"
    method = "GET"
    path = "/ok"

[env]
  PG_POOL_MAX = "5"
  SKEIN_RUN_CONCURRENCY = "5"
```

```bash
fly deploy .skein/build --config "$PWD/fly.toml"
```

## 4. Verify

Run the [verification sequence](./deploy.md#verify-a-deployment) against
`https://YOUR_APP.fly.dev`, using the app you created in step 1.

## Fly caveats

### Fly does not set `PORT` — keep `internal_port` in sync yourself

Unlike Railway, Render, Cloud Run and App Runner, Fly injects no `PORT` variable;
[`internal_port` is only an instruction to Fly's proxy](https://fly.io/docs/machines/runtime-environment/),
and the app is expected to know its own port. The config above works because `internal_port` matches
the port skein binds when nothing tells it otherwise (8123).

So if you change one, change the other. Either set `internal_port` to 8123 and leave it alone, or
declare the port explicitly on both sides:

```toml
[http_service]
  internal_port = 3000

[env]
  PORT = "3000"
```

A mismatch here produces Fly's `app is not listening on the expected address` warning and a machine
that never passes its health check.

### Background runs need a machine that stays awake

`auto_stop_machines` suspends or stops a Machine when it has no traffic. skein's background runs
execute _after_ the HTTP request returns, so a machine that stops the moment the response is sent
will freeze them mid-run. Set `auto_stop_machines = "off"` and `min_machines_running = 1`.

If you only use inline runs (`/runs/wait`, `/runs/stream`), auto-stop is fine — the work happens
during the request.

### Raise `kill_timeout`

Fly's default is 5 seconds, which is exactly skein's drain window with nothing left for the abort
step that settles in-flight runs terminally. 15s gives the default
[shutdown sequence](./deploy.md#graceful-shutdown) room; raise both together if you increase
`SKEIN_SHUTDOWN_GRACE_MS`.

### Multi-region

Machines in several regions all talk to one Postgres primary, so far-away regions pay the write
latency. Multi-region here buys you edge termination, not database HA. And with more than one Machine
running, read [Scaling past one instance](./deploy.md#scaling-past-one-instance).
