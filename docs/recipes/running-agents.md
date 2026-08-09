# Running agents

Getting work started, keeping it from duplicating, pausing it for a human, and bounding it.

## Background runs, join and cancel

Kick off a long run, return immediately, stream it from anywhere.

```ts
const run = await client.runs.create(threadId, "agent", { input }); // returns immediately
for await (const ev of client.runs.joinStream(threadId, run.run_id)) console.log(ev);
await client.runs.cancel(threadId, run.run_id);
```

Cross-instance join needs the Redis queue + bus ([runs-and-redis.md](../runs-and-redis.md)). Concurrent
runs on **one** thread follow `multitask_strategy`; how many run at once across **different** threads is
[run concurrency](../runs-and-redis.md#run-concurrency) (default 10).

Working version: [`triage-agent`](https://github.com/skein-js/skein-js/tree/main/examples/triage-agent)
— one background run per issue, each on its own thread.

## Scheduled runs (crons)

Fire a graph on a schedule. Schedules live in the store, so they survive restarts and fire exactly once
across instances — no leader election.

```ts
await client.crons.create("agent", { schedule: "*/5 * * * *", input: { source: "queue" } });
```

Cron delivery is **at-least-once**: an occurrence committed but never queued is re-enqueued by the
scheduler's sweep. Working version:
[`triage-agent`](https://github.com/skein-js/skein-js/tree/main/examples/triage-agent) — a sweep that
dispatches one run per issue. Details: [crons.md](../crons.md).

## Don't create the same run twice

A retrying caller — Twilio, Stripe, GitHub, or your own sweep — should not start a second run. Send an
`Idempotency-Key` and the original response replays.

```ts
// `runs.create` has no `headers` option — a `headers` key in the payload is silently dropped and you
// get a brand-new run every retry. A per-key client is the only way to send it.
const client = new Client({ apiUrl, defaultHeaders: { "Idempotency-Key": issue.id } });
await client.runs.create(threadId, "agent", { input });
```

The claim is an insert arbitrated by a uniqueness constraint, so 50 concurrent retries across two
instances still produce exactly one run. Keys are scoped per principal, failures are never recorded, and
the **streaming** creates reject the header rather than ignoring it — an SSE response has no body to
replay. **LangGraph Platform has no equivalent.**

Working version: [`triage-agent`](https://github.com/skein-js/skein-js/tree/main/examples/triage-agent)
— re-sweeping creates nothing. Details:
[agent-protocol.md](../agent-protocol.md#idempotent-run-creation-idempotency-key).

## Human-in-the-loop (interrupt / resume)

Pause for approval, resume later — possibly hours later, from a different client. An interrupted run
holds no connection and no timer, only a checkpoint.

```ts
import { interrupt } from "@langchain/langgraph";

async function approve(state) {
  const decision = interrupt({ question: "Send this email?", draft: state.draft });
  return { sent: decision === "yes" };
}
```

The thread's status becomes `interrupted` and the interrupt surfaces in the stream; resume by submitting
a `command`. [`useStream`](../react-sdk.md) renders and resumes it for free.

Working versions:
[`triage-agent`](https://github.com/skein-js/skein-js/tree/main/examples/triage-agent) (reached by a
conditional edge) and [`chat-app`](https://github.com/skein-js/skein-js/tree/main/examples/chat-app)
(approval card in the UI).

## Bound a runaway run

A graph that hangs — a model call with no timeout of its own, a node that loops — holds a worker slot
until the process restarts. Set `--run-timeout <ms>` or `SKEIN_RUN_TIMEOUT_MS`; the run aborts and
settles as `timeout`.

**Off by default, deliberately.** A legitimate research or multi-step tool run takes minutes, so a
default would turn slow-but-working into killed — the exact failure the timeout exists to prevent. Pick a
number from your own graphs' worst honest case.

## Re-run a turn a different way

Fork from any past checkpoint and run from there, leaving the original branch intact — useful for
retrying a decision with different input, or debugging what a node saw.

```ts
await client.runs.create(threadId, "agent", { input, checkpointId });
```

The fork target is server-validated, so a client cannot redirect a run to an arbitrary checkpoint through
config. Visible in the [console](../console.md); details: [agent-protocol.md](../agent-protocol.md).
