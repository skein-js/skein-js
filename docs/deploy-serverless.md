# Vercel, Netlify, Lambda — what works and what doesn't

**Postgres and Redis are required for Skein’s standard production server.** Host your frontend
on Vercel, Netlify, or another serverless platform and run Skein on a separate, long-running
host. Set both service URLs on that backend so queued work can continue after the request ends.
[Choose a backend deployment platform](./deploy.md#pick-a-platform)

This page exists because "deploy LangGraph on Vercel" is a reasonable thing to try, and the failure
mode is quiet — everything looks fine until a background run never finishes.

## Why background runs can't work

`POST /threads/{id}/runs` enqueues a run and responds immediately. A background worker picks it
up and executes it — _after_ the HTTP response has been sent.

On a serverless platform, that's exactly when the execution context is frozen or destroyed. The
request is over, so the work stops. The run sits at `pending` or `running` forever, and nothing about
the response told you anything was wrong.

Several other things follow from the same property:

- **The in-memory queue and event bus are per-invocation.** Every cold start gets its own, so a run
  enqueued by one invocation is invisible to the next.
- **Cancellation and the per-thread run guard are in-process** ([details](./deploy.md#scaling-past-one-instance)),
  and "in-process" on serverless means "for the lifetime of one request".
- **No `SIGTERM` drain.** Nothing gets the chance to settle in-flight runs terminally.
- **Boot cost on every cold scale-out.** skein runs migrations, seeds assistants, and warms graphs at
  startup — that's a container-lifetime cost, not a per-request one.
- **Postgres connections.** Serverless concurrency multiplies database connections. Check your
  [connection budget](./deploy.md#connection-budget) before scaling out.

## What does work

If you keep to **inline runs**, the work happens _during_ the request, and a function can serve it:

- `POST /threads`, `GET /threads/{id}/state`, the assistants and store routes — ordinary request
  /response.
- `POST /threads/{id}/runs/wait` — runs to completion inside the request.
- `POST /threads/{id}/runs/stream` — works where the platform supports streaming responses and your
  `maxDuration` covers the whole run.

For an inline-only embedding, use a [direct Postgres connection](./deploy.md#tls-to-the-database)
for state and checkpoints. Use the long-running backend for the queued
`POST /threads/{id}/runs` route.

## The shape that actually works

Put the UI on Vercel and the agent server in a container:

```text
Vercel (Next.js UI, useStream)  ──►  skein container on Cloud Run / Fly / Render
                                        │
                                        ├── Postgres  (state + checkpoints)
                                        └── Redis     (queue + stream fan-out)
```

This is what [`examples/nextjs-app`](https://github.com/skein-js/skein-js/tree/main/examples/nextjs-app) is shaped like, and it keeps the
`useStream` developer experience while letting background runs, webhooks and long-running work
behave. Point the frontend at the Skein API URL and keep `POSTGRES_URI` and `REDIS_URI` in the
backend’s secrets. See [react-sdk.md](./react-sdk.md) for the client side.

## If you deploy the Next.js adapter to Vercel anyway

For an inline-only workload it can be a reasonable trade. Two specifics:

- **The Next.js adapter registers no `/ok` route.** The other adapters add one; this one exposes route
  handlers only. Add your own `app/ok/route.ts` if something needs to probe it.
- **Set `maxDuration`** on the streaming route to at least your longest run, and remember skein
  imposes no run timeout of its own — the platform's limit is the only ceiling.

And revisit [the auth warning](./deploy.md#5-auth--read-this-before-you-expose-it): a Vercel
deployment is public by default.
