# Background jobs

Fire-and-forget work: hand skein a job, get an id back immediately, and hear about the result later.
No conversation to maintain, no connection to hold open. This is the shape you want when the caller is
another service rather than a person — classification, enrichment, document processing, a queue
drained by an agent.

There is no separate "tasks" API. A background job **is** a run — you just don't keep the thread.

## Enqueue and return

```ts
const run = await client.runs.create(null, "agent", {
  input: { documentUrl },
  onCompletion: "delete", // don't keep the thread once it's done
  webhook: "https://example.com/hooks/done", // tell me when it lands
});
// returns in milliseconds; the graph runs server-side
```

`null` for the thread id means **stateless**: skein creates a thread for the run, and
`onCompletion: "delete"` removes it once the run settles. Nothing accumulates.

Leave `onCompletion` off (skein's default is `keep`) if you'd rather the job stay inspectable
afterwards — you can read its state and its checkpoints for as long as you keep it.

## Hearing the result

Three ways, in order of how much they cost you:

| Approach                            | Use when                                                       |
| ----------------------------------- | -------------------------------------------------------------- |
| A [webhook](./webhooks.md)          | The default. Nothing to poll, and delivery survives a redeploy |
| `client.runs.join(threadId, runId)` | You can hold a connection and just want the answer             |
| `client.runs.get(threadId, runId)`  | You already have a polling loop                                |

The webhook is the one to reach for. It's recorded in the same transaction as the run's terminal
status, so a receiver that was restarting doesn't lose the news — and you can
[see and replay](./webhooks.md#see-what-a-callback-did-and-replay-it) a callback that never landed.

If you kept the thread (`onCompletion: "keep"`), joining works long after the run settled — the wait is
decided by the run row, not by a live stream. If you deleted it, the webhook payload is the record;
that's exactly why the payload is stored rather than re-rendered at send time.

## Don't run the same job twice

A retrying caller — a queue, a cron, a partner's webhook — will re-send. Send an `Idempotency-Key` and
the original response replays instead of starting a second run:

```ts
// `runs.create` has no `headers` option, so a per-key client is the only way to send it.
const client = new Client({ apiUrl, defaultHeaders: { "Idempotency-Key": documentId } });
await client.runs.create(null, "agent", { input, onCompletion: "delete" });
```

The claim is arbitrated by a uniqueness constraint, so 50 concurrent retries across two instances
still produce exactly one run. Details:
[agent-protocol.md](./agent-protocol.md#idempotent-run-creation-idempotency-key).

## Many, later, or on a schedule

```ts
// Up to 100 at once
await client.runs.createBatch(items.map((item) => ({ assistantId: "agent", input: item })));

// Start in 30 seconds (capped at a day)
await client.runs.create(null, "agent", { input, afterSeconds: 30 });

// Every five minutes, forever
await client.crons.create("agent", { schedule: "*/5 * * * *", input: { source: "queue" } });
```

A delayed background run is held by the queue, so it costs nothing while it waits and — on Redis —
survives a restart. For anything longer than a day, use a [cron](./crons.md).

## How many run at once

One instance executes **10** background runs concurrently by default, matching the LangGraph CLI's
`--n-jobs-per-worker`. Raise it with `--concurrency` or `SKEIN_RUN_CONCURRENCY` when your jobs are
I/O-bound (model calls); add instances when they're CPU-bound.

Concurrency is the knob with the widest blast radius — it multiplies memory and Postgres connections
at once. Size it against your pool: [runs-and-redis.md](./runs-and-redis.md#run-concurrency).

## What you must get right

- **A failed job is not retried.** skein retries webhook _delivery_, not the run. A graph that throws
  settles `error` and stays there. If your work needs retries, either retry inside the graph, or have
  your caller re-submit with a fresh idempotency key.
- **A crashed worker is different.** If the process dies mid-run, the job is recovered rather than
  lost — and re-delivery is safe, because a run already terminal in the store is skipped.
- **Background runs need a process that stays alive.** They execute after your request returns, so
  they don't work on serverless. See [deploy-serverless.md](./deploy-serverless.md).
- **Use durable storage.** With the in-memory driver a queued job is gone on restart. Postgres for
  state, Redis for the queue — [runs-and-redis.md](./runs-and-redis.md).
- **Bound a job that hangs.** A graph with no timeout of its own holds a worker slot until the process
  restarts. Set `--run-timeout` / `SKEIN_RUN_TIMEOUT_MS`; it's off by default.
- **Each job holds a Postgres connection** while it runs, and a second one on the Postgres driver for
  its thread claim. Ten concurrent jobs is not one connection.

## When you want the answer inline instead

If the caller can wait and there's genuinely no conversation — a classifier, an extractor — skip runs
entirely:

```bash
curl -sX POST localhost:2024/invoke/triage \
  -H 'content-type: application/json' \
  -d '{"text":"Refund charge failed — urgent!"}'
```

`POST /invoke/:graph_id` takes the graph's input as the body and answers with its final state. No
threads, no run rows, no webhooks. See
[serving-a-single-graph.md](./serving-a-single-graph.md).

## Working example

[`triage-agent`](https://github.com/skein-js/skein-js/tree/main/examples/triage-agent) is exactly this
shape: a cron sweep dispatches one durable background run per item, idempotently, so re-sweeping
creates nothing. It runs with no API key and no network.

## See also

- [Runs](./runs.md) — every run mode and field
- [Webhooks](./webhooks.md) — being told a run finished
- [Crons](./crons.md) — running a graph on a schedule
- [Runs & Redis](./runs-and-redis.md) — the queue, concurrency, scaling out
- [Serving a single graph](./serving-a-single-graph.md) — the synchronous non-chat surface
