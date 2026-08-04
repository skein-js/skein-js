# Cron / scheduled runs

Schedules that fire a run on a cadence — LangGraph Platform's **Crons** resource, served by skein-js
and driven by the official `@langchain/langgraph-sdk` client.

> **Compatibility note:** crons are **not** part of the open
> [Agent Protocol](https://github.com/langchain-ai/agent-protocol) spec — its `openapi.json` has no
> cron paths. They are a LangGraph Platform / LangSmith Deployment extension, and a paid-tier one.
> The OSS [`@langchain/langgraph-api`](https://github.com/langchain-ai/langgraphjs/tree/main/libs/langgraph-api) server
> registers the routes but every handler throws `500 Not implemented`, and its `GET /info` reports
> `crons: false`. skein implements them against the LangSmith Deployment OpenAPI spec plus the SDK's
> TypeScript types — the same oracle the rest of the wire surface uses ([reuse.md](./reuse.md)).

**A cron is a _cadence_, not a delay.** To run something once, a little later, pass
[`after_seconds`](./agent-protocol.md) on an ordinary run create — no cron row, nothing to clean up
afterwards. Reach for a cron when the run should keep happening.

## Contents

- [Quick start](#quick-start)
- [Stateless vs thread crons](#stateless-vs-thread-crons)
- [Schedule format](#schedule-format)
- [Endpoints](#endpoints)
- [Semantics](#semantics)
- [Driver requirements](#driver-requirements)
- [How it works](#how-it-works)
- [Operating a scheduler](#operating-a-scheduler)
- [Authentication](#authentication)

## Quick start

```ts
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });

// Every weekday at 09:00 New York time, on a fresh thread each fire.
const cron = await client.crons.create("agent", {
  schedule: "0 9 * * 1-5",
  timezone: "America/New_York",
  input: { messages: [{ role: "user", content: "Summarize yesterday's issues." }] },
});

// What has it produced? A stateless cron makes a thread per fire, each tagged with the cron id.
const threads = await client.threads.search({ metadata: { cron_id: cron.cron_id } });
const runs = await client.runs.list(threads[0].thread_id);

await client.crons.update(cron.cron_id, { enabled: false }); // pause
await client.crons.delete(cron.cron_id);
```

`assistant_id` accepts a UUID **or a graph name** from your `langgraph.json` — a graph name resolves
to the assistant skein auto-registers for it.

## Stateless vs thread crons

|                 | Stateless (`crons.create`)                    | Thread (`crons.createForThread`)           |
| --------------- | --------------------------------------------- | ------------------------------------------ |
| Thread          | A fresh one per fire                          | The one you named, reused every fire       |
| State           | Starts clean each time                        | Accumulates across fires                   |
| Default cleanup | `on_run_completed: "delete"`                  | n/a — the thread is yours                  |
| Concurrency     | Cannot collide (each fire has its own thread) | `multitask_strategy` defaults to `enqueue` |

Use a **stateless** cron for independent jobs (a nightly digest). Use a **thread** cron when each run
should see what the previous ones did (a long-running monitor).

> **`on_run_completed` defaults to `"delete"`**, matching LangGraph — and deliberately _unlike_
> skein's own `on_completion` default of `"keep"` for one-off stateless runs. A schedule is the case
> where the difference bites: a five-minutely cron keeping every thread accrues over a hundred
> thousand of them a year, with nobody watching. Pass `on_run_completed: "keep"` if you want them,
> and give the checkpointer a TTL.

## Schedule format

**Standard 5-field cron only** — minute, hour, day-of-month, month, day-of-week:

```
┌───────── minute (0-59)
│ ┌─────── hour (0-23)
│ │ ┌───── day of month (1-31)
│ │ │ ┌─── month (1-12)
│ │ │ │ ┌─ day of week (0-6, Sunday = 0)
│ │ │ │ │
0 9 * * 1-5
```

Six-field (seconds-first) expressions, `@daily`-style nicknames, and `L`/`?` are **rejected with a
422**, matching LangGraph's _"cron must be a standard 5-field expression"_. skein's parser
([croner](https://github.com/hexagon/croner)) would accept them, so the five-field rule is enforced
before the expression reaches it: silently running `0 0 9 * * *` at a different time than the author's
crontab says is worse than refusing it.

`timezone` is an optional IANA name (`America/New_York`); absent or `null` means UTC. DST is handled:
an occurrence in a spring-forward gap shifts forward into the same day rather than being skipped, and
a repeated fall-back hour fires once.

The finest resolution is **one minute**. Sub-minute schedules are not expressible and are a
[non-goal](./roadmap.md).

## Endpoints

| Method   | Path                              | Notes                               |
| -------- | --------------------------------- | ----------------------------------- |
| `POST`   | `/runs/crons`                     | Stateless cron → `Cron`             |
| `POST`   | `/threads/{thread_id}/runs/crons` | Thread cron → `Cron`                |
| `POST`   | `/runs/crons/search`              | → `Cron[]`, `x-pagination-total`    |
| `POST`   | `/runs/crons/count`               | → a **bare integer**                |
| `GET`    | `/runs/crons/{cron_id}`           | → `Cron`                            |
| `PATCH`  | `/runs/crons/{cron_id}`           | → `Cron`                            |
| `DELETE` | `/runs/crons/{cron_id}`           | → **200** with a JSON body, not 204 |

All seven answer the full `Cron` object. Two response shapes are deliberately unusual because the
official SDK requires them: `count` returns a bare integer rather than `{ count }`, and `DELETE`
returns 200 with a body (the SDK skips `response.json()` only for 202 and 204, so an empty 200 makes
it throw).

`search` accepts `assistant_id`, `thread_id`, `enabled`, `metadata` (subset match), `limit`, `offset`,
`sort_by`, `sort_order`, and `select`. `select` is validated and then ignored — skein always returns
the whole row.

Set `"http": { "disable_crons": true }` in `langgraph.json` to remove the resource. That also stops
the scheduler, so a disabled deployment does not keep firing schedules nobody can see or cancel.

## Semantics

**Pausing.** `enabled: false` stops a cron without deleting it; the row stays readable and
`next_run_date` becomes `null`. Re-enabling recomputes it.

**`next_run_date === null` means dormant** — disabled, past `end_time`, or an unreachable expression
(`0 0 30 2 *`). It is the same field the scheduler indexes on, so the wire answer and the firing
behaviour can never disagree.

**`end_time`** is inclusive: an occurrence falling exactly on it still fires. On `PATCH` it is
tri-state — omit to leave it, send `null` to clear it, send a value to set it. Same for `timezone`.

**Metadata merges** on `PATCH` rather than being replaced. The run **payload** is replaced wholesale
when a patch touches any run field, because a half-replaced request (new `input`, stale `config`) is
not a request anyone asked for.

**Catch-up.** If the server is down when occurrences pass, the cron fires **once** on return and
resyncs to the next future occurrence. It does not backfill: replaying an hour of a five-minutely
schedule is twelve times the model spend on near-identical inputs, and on a thread cron they serialize
so the catch-up becomes the outage. This matches APScheduler's `coalesce` default; there is no knob.

**Traceability.** Every fired run — and every thread a stateless cron creates — carries `cron_id` in
its metadata. For a **stateless** cron that makes `client.threads.search({ metadata: { cron_id } })`
the way in, since each fire has its own thread; for a **thread** cron the thread is already known, so
`client.runs.list(thread_id)` lists the runs and each carries the `cron_id` that produced it. (The SDK
has no `runs.search` — runs are always addressed through their thread.)

**Failures.** If a fire fails (a deleted assistant, a store error) the cron is logged at `error`,
counted, and **left enabled** — the next occurrence is the retry. skein never auto-disables a
schedule: turning a thirty-second rolling-deploy blip into a silently stopped cron needing a human is
the worse failure.

**Deleting a thread deletes its thread crons**, by foreign key. A cron cannot outlive the thread it
runs on.

## Driver requirements

Crons work on **every** store/queue combination, including `skein dev` on memory with no Docker.

| Store    | Queue  | Crons                                             | Posture                   |
| -------- | ------ | ------------------------------------------------- | ------------------------- |
| memory   | memory | Work; snapshotted to `.skein/` by `skein dev`     | Development               |
| postgres | memory | Durable; single-instance delivery                 | Fine for small production |
| postgres | redis  | Durable; at-least-once delivery; multi-instance   | **Recommended**           |
| memory   | redis  | Work, but **lost on restart** outside `skein dev` | Warned about at startup   |

The scheduler logs one warning at startup on a non-durable store. A schedule that quietly stops is
worse than one that was never created, and an embedded memory store in production loses every cron on
every deploy.

## How it works

Every instance runs a ticker. Every 30 seconds (`SKEIN_CRON_TICK_MS`) it asks the store for enabled
crons whose `next_run_date` has arrived, and for each one:

1. Computes the **next** occurrence, from the later of the stored date and now — so a cron that fell
   behind lands in the future in one step rather than replaying the backlog.
2. **Claims** it with a single-row conditional `UPDATE` on the primary key, guarded by a claim token
   the store bumps on every write. If three instances see the same occurrence, exactly one wins; the
   others skip. No leader election, no distributed lock, no Redis.
3. Commits the claim **and the `pending` run row in one transaction**, then enqueues the run.

That third step is a transactional outbox, and it is what makes delivery durable. Advancing without
the run would silently skip the occurrence if the instance died in between; creating the run first
would re-fire it. Committed together, the worst case is a `pending` run that never reached the queue —
which the next tick re-enqueues. Because enqueue is idempotent (keyed on the run id) and the worker
skips runs already terminal, delivery is **at-least-once** and execution **exactly-once**.

The recovery sweep looks only at runs a cron produced. A bare `pending` is not enough to conclude a
run is waiting for a worker: an inline `wait`/`stream` run is written `pending` too and only becomes
`running` once it acquires its thread's lock, so one queued behind a long peer would look identical
while its caller waits to execute it in-process. Handing that to a worker would run the graph twice.

The run itself then goes through the ordinary run queue — on Redis that is BullMQ, so cron-fired runs
get its retries, backoff, and stalled-job crash recovery like any other background run.

Schedule state lives in the store rather than in the queue, because `enabled`, `sort_by=next_run_date`,
filtered `count`, and metadata search are all things a queue cannot serve — and because a schedule
that a `FLUSHALL` can erase while the API still reports it as enabled is worse than no schedule.

## Operating a scheduler

**The one metric to alert on is cron lag** — how overdue the most overdue enabled cron is. Healthy, it
stays below one tick; if the scheduler dies it climbs without bound. It is the only signal that
distinguishes "nothing is due" from "nothing is running the crons". Each tick reports it, along with
counts of fired / claims lost / failed / re-enqueued runs.

Claims lost are **not** errors: on N instances, N−1 lose every occurrence by design.

| Setting              | Default | Notes                                                         |
| -------------------- | ------- | ------------------------------------------------------------- |
| `SKEIN_CRON_TICK_MS` | `30000` | Lower does not help below one minute; higher trades lateness. |

**Serverless caveat.** Nothing fires if no process is running. On Cloud Run that means
`--no-cpu-throttling` and `--min-instances=1` — see [deploy-cloud-run.md](./deploy-cloud-run.md).
Scale-to-zero and cron are incompatible, and no queue changes that.

## Authentication

Crons are a first-class auth resource, so `@auth.on.crons.create`, `.read`, `.update`, `.delete`, and
`.search` all work — matching the SDK's own `Auth` class.

**If you have not registered a cron handler, crons inherit your `threads` scoping.** This matters,
because `@auth.on` callbacks are matched by exact event key: a deployment that wrote
`.on("threads", …)` has no callback named `crons`, and without the fallback the whole resource would
be served unscoped. Since a schedule is really "runs on a thread, later", `threads` is both the safe
default and the honest one — cron routes fall back to it, and `create` specifically falls back to
`threads:create_run`.

**Attaching a schedule to a thread is always authorized as `threads:create_run`**, separately from
the cron handler. A cron writes into a thread indefinitely, so it is gated by thread ownership even
when your cron handler is more permissive than your thread handler. A thread you cannot read answers
404, exactly as it does everywhere else.

A cron fires with no HTTP request behind it, so skein remembers the **creating principal** (beside the
row, never on the wire) and replays it into every run. The ownership filters are re-derived from your
`@auth.on` handler at fire time rather than frozen at create time, which means:

- Editing your auth handler applies to existing crons immediately.
- Revoking a principal stops their crons producing runs; re-granting resumes them.
- A stateless cron's per-fire thread is owner-stamped, so the user who created the cron can actually
  find its results in their own `POST /threads/search`.

See [agent-protocol.md](./agent-protocol.md#authentication--authorization) for the request lifecycle.
