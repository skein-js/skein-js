# Deploy on Fly.io

Fly runs your container as Machines close to your users, with private networking between apps. It
builds straight from a `Dockerfile` in your repo, so the skein image needs no registry of its own.

Everything platform-agnostic — environment variables, pool sizing, probes, scaling caveats — is in
[deploy.md](./deploy.md).

## Contents

- [Before you start](#before-you-start)
- [1. Commit the Dockerfile](#1-commit-the-dockerfile)
- [2. Provision Postgres + Redis](#2-provision-postgres--redis)
- [3. Configure and deploy](#3-configure-and-deploy)
- [4. Verify](#4-verify)
- [Fly caveats](#fly-caveats)

## Before you start

Install `flyctl` and log in (`fly auth login`). Fly builds remotely by default, so you don't need
Docker locally and the architecture is handled for you.

## 1. Commit the Dockerfile

```bash
skein dockerfile -o Dockerfile
```

Commit it. Note the build context: the Dockerfile builds a `.skein/build` artifact, so run
`skein build` in CI (or before `fly deploy`) to produce it — Fly deploys the directory containing the
artifact.

## 2. Provision Postgres + Redis

```bash
fly postgres create      # or use Fly Managed Postgres, or any external provider
fly redis create         # Upstash Redis, provisioned through Fly
```

Fly's unmanaged Postgres is a database _you_ operate — fine for smaller deployments, but read Fly's
docs on what they do and don't take responsibility for. Managed Postgres or an external provider
(Neon, Supabase) is the lower-effort choice.

Attach them and set the two variables skein reads:

```bash
fly secrets set \
  POSTGRES_URI="postgres://…" \
  REDIS_URI="redis://…"
```

Prefer the `.internal` (6PN private network) hostnames. Private traffic is plaintext inside your
organization's network, so no TLS configuration is needed.

## 3. Configure and deploy

```toml
# fly.toml
app = "my-skein-app"
primary_region = "iad"

[build]

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

# Fly's default kill_timeout is 5s — too tight for skein's drain plus abort.
kill_signal = "SIGTERM"
kill_timeout = "15s"
```

```bash
fly deploy
```

## 4. Verify

Run the [verification sequence](./deploy.md#verify-a-deployment) against
`https://my-skein-app.fly.dev`.

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
