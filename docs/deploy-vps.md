# Deploy on a VPS (plain Docker)

**Postgres and Redis are required for Skein’s standard production server.** Use the Compose
example to run both on the VPS with persistent volumes, or connect the app to managed services.

Everything platform-agnostic — environment variables, pool sizing, probes, scaling caveats — is in
[deploy.md](./deploy.md).

## The quickest version

If you already have reachable services, put their direct Postgres and writable Redis URLs in an
untracked, owner-readable `skein.env` file as `POSTGRES_URI` and `REDIS_URI`. Follow the provider’s
TLS settings and include any model or tool credentials the graph needs.

```bash
skein build -t my-agent
docker run -d --name my-agent -p 127.0.0.1:8123:8123 \
  --env-file skein.env \
  --restart unless-stopped --init \
  my-agent
curl -s localhost:8123/ok      # {"ok":true}
```

No `PORT` needed — with nothing injected the server binds 8123, the port the image exposes and
health-checks.

## A real deployment with Compose

`skein build` creates the app image. Save the Compose example below separately as `compose.yaml`
in your project directory.

```bash
skein build -t my-agent
```

Add `POSTGRES_PASSWORD` to an untracked `.env` file beside `compose.yaml` and restrict the file to
mode `0600`. Use a strong URL-safe password, such as the output of `openssl rand -hex 32`, so
Compose can insert it directly into the Postgres URL. For model or tool credentials, add an
`env_file` entry under `app` pointing to a separate, owner-readable file.

```yaml
services:
  app:
    image: my-agent
    init: true # reap zombies if your graphs spawn child processes
    ports:
      - "127.0.0.1:8123:8123" # only the reverse proxy reaches it
    environment:
      POSTGRES_URI: postgresql://postgres:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}@postgres:5432/skein
      REDIS_URI: redis://redis:6379
      PG_POOL_MAX: "5"
      SKEIN_RUN_CONCURRENCY: "5"
      SKEIN_SHUTDOWN_GRACE_MS: "20000"
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    restart: unless-stopped
    stop_grace_period: 30s # must exceed the drain window above

  postgres:
    # Use pgvector/pgvector:pg16 if langgraph.json sets store.index.
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: skein
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d skein"]
      interval: 5s
      retries: 10
    restart: unless-stopped

  redis:
    image: redis:7
    command: ["redis-server", "--maxmemory-policy", "noeviction", "--appendonly", "yes"]
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 10
    restart: unless-stopped

volumes:
  pgdata:
  redisdata:
```

```bash
docker compose up -d
```

Skein initializes the Postgres schema on boot. The named volumes keep Postgres state and Redis
queue and replay data across container replacements. The database ports are available only on the
Compose network.

## Run it as a service

`restart: unless-stopped` survives crashes; a systemd unit also survives reboots and gives you
`journalctl`:

```ini
# /etc/systemd/system/skein.service
[Unit]
Description=skein agent server
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/srv/skein
EnvironmentFile=/srv/skein/.env
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now skein
```

## Run it without Docker

If the box has Node and you would rather not run a daemon, skip the image entirely — see
[Without Docker](./deploy.md#without-docker) for what `skein build --artifact-only` produces and how
`skein start` differs from the container entrypoint. Postgres and Redis still have to come from
somewhere: managed services, or packages on the same box.

```bash
# build anywhere with Node, ship the artifact
skein build --artifact-only
rsync -a .skein/build/ server:/srv/skein/

# on the server
cd /srv/skein && npm install --omit=dev
```

```ini
# /etc/systemd/system/skein.service
[Unit]
Description=skein agent server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=skein
WorkingDirectory=/srv/skein
EnvironmentFile=/srv/skein/.env
ExecStart=/usr/bin/node /srv/skein/node_modules/skein-js/dist/index.js start
Restart=always
RestartSec=2
# SIGTERM drains in-flight runs before exiting; give it more than SKEIN_SHUTDOWN_GRACE_MS so systemd
# doesn't SIGKILL a run mid-flight. `skein start` force-exits 3s after that grace window regardless.
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now skein
journalctl -u skein -f
```

`skein start` binds `127.0.0.1:8123` by default, which is what you want with Caddy or nginx in front
on the same host. Deploying a new version is `rsync` + `npm install --omit=dev` +
`systemctl restart skein` — migrations run on boot, so there is no separate step.

## TLS and streaming

Terminate TLS in front and **turn response buffering off**, or SSE streams will appear to hang until
each run finishes.

Caddy — the shortest path to automatic HTTPS:

```caddyfile
agents.example.com {
	reverse_proxy 127.0.0.1:8123 {
		flush_interval -1 # stream immediately; required for SSE
	}
}
```

nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8123;
    proxy_http_version 1.1;
    proxy_buffering off;          # required for SSE
    proxy_cache off;
    proxy_read_timeout 3600s;     # skein sends no heartbeat frame
    proxy_set_header Connection "";
}
```

## Verify

Run the [verification sequence](./deploy.md#verify-a-deployment) against your domain.

## Operating it

- **Firewall.** Publish 80/443 only. Bind the app to `127.0.0.1` as above, and never expose 5432 or
  6379 — the Compose network already connects them internally.
- **Auth.** A public VPS is the easiest place to forget that
  [skein's auth is off by default](./deploy.md#5-auth--read-this-before-you-expose-it). Configure
  `auth.path`, or keep the box behind a VPN or an authenticating proxy.
- **Backups.** The Postgres volume holds threads, runs, checkpoints, and store items.
  `docker compose exec postgres pg_dump -U postgres skein | gzip > backup.sql.gz`, on a schedule,
  stored off the box.
- **Updates.** `skein build -t my-agent && docker compose up -d`. Migrations run on boot; there is no
  separate migrate step.
- **One box is one instance**, so the cross-instance machinery
  ([Scaling past one instance](./deploy.md#scaling-past-one-instance)) never has to do anything —
  cancellation and the per-thread run guard stay entirely in-process, and you pay for neither.
