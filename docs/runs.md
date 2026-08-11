# Runs

A run is one execution of your graph. Starting one is the single most common thing you'll do against
skein, and the shape you pick — wait for it, stream it, or queue it — decides everything about how
your client has to behave.

## Pick a run mode

| You want                                     | Use                                        | You get                                   |
| -------------------------------------------- | ------------------------------------------ | ----------------------------------------- |
| The answer, and you can hold a connection    | `client.runs.wait(threadId, …)`            | The final state, as JSON                  |
| Tokens as they're produced (a chat UI)       | `client.runs.stream(threadId, …)`          | An SSE stream                             |
| To return immediately and check back later   | `client.runs.create(threadId, …)`          | The `Run` row; work continues server-side |
| A one-shot call with no conversation to keep | The same three, with `null` for the thread | skein creates and owns the thread         |
| To start many at once                        | `client.runs.createBatch([…])`             | Up to 100 runs per request                |

```ts
// Wait for it
const state = await client.runs.wait(threadId, "agent", { input });

// Stream it
for await (const chunk of client.runs.stream(threadId, "agent", {
  input,
  streamMode: "messages",
})) {
  // …
}

// Queue it, come back later
const run = await client.runs.create(threadId, "agent", { input });
for await (const ev of client.runs.joinStream(threadId, run.run_id)) console.log(ev);
```

**Background runs need somewhere to run.** They execute on the server after your request returns, so
they need a process that stays alive — which is why they don't work on serverless platforms. See
[what doesn't work on serverless](./deploy-serverless.md).

Streaming is its own topic — the stream modes, reconnecting mid-stream, and joining from a second
client are in [streaming.md](./streaming.md).

## Multitask: what happens to the run already going

Send a second message before the first finishes ("double-texting") and something has to give. Pass
`multitask_strategy` on the second run to say what:

| Strategy    | The run already going       | The new run        | Reach for it when                                                                          |
| ----------- | --------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `reject`    | Keeps going                 | **Fails with 422** | The default. A second message is a bug or a double-click                                   |
| `interrupt` | Stops, keeps what it wrote  | Starts now         | The user changed their mind, and the partial answer is still worth keeping                 |
| `rollback`  | Stops, its writes discarded | Starts now         | The user is correcting themselves — the abandoned turn should read as if it never happened |
| `enqueue`   | Runs to completion          | Waits, then runs   | Both messages matter and order is what you want                                            |

```ts
await client.runs.create(threadId, "agent", { input, multitaskStrategy: "interrupt" });
```

Things worth knowing before you pick:

- **`reject` is the default, and a `pending` run counts as busy.** A run held by `afterSeconds`, or
  one sitting in the queue, will reject the next one just as a running one does. That surprises
  people — but work _is_ scheduled on the thread.
- **The 422 is `thread_busy`.** Handle it distinctly from an ordinary validation failure: the
  client's move is to retry or to switch strategy, not to fix the request.
- **`enqueue` is not strict FIFO** unless you run at concurrency 1. Several queued runs on one thread
  are dequeued together and race for the thread. See
  [head-of-line blocking](./runs-and-redis.md#head-of-line-blocking).
- **It's decided atomically**, so two instances racing the same thread cannot both win. You don't need
  a lock of your own.

A displaced run settles `interrupted` (under `interrupt`) or `cancelled` (under `rollback`), and one
that never started executing sends no [webhook](./webhooks.md).

## Cancelling

```ts
await client.runs.cancel(threadId, runId); // action: "interrupt", the default
```

| `action`                | Effect                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `interrupt` _(default)_ | Settles the run `cancelled` and **keeps** whatever it wrote                                           |
| `rollback`              | Also discards its checkpoint writes and deletes the run row — the turn reads as never having happened |

> [!WARNING]
> **`cancel` takes these positionally, not as an options object.** The signature is
> `cancel(threadId, runId, wait?, action?)`, so `cancel(tid, rid, { action: "rollback" })` binds your
> object to `wait` and silently performs an ordinary `interrupt` instead.

```ts
await client.runs.cancel(threadId, runId, true, "rollback"); // wait for it to stop, discard its writes
```

The third argument returns only once the run has actually stopped, rather than as soon as it's been
marked.

To cancel in bulk, `POST /runs/cancel` takes `{ thread_id?, run_ids?, status? }`, narrowest selector
first: explicit ids, else one thread's inflight runs, else **every** inflight run on the server.
Unknown ids are skipped rather than failing the sweep, and the response says what actually happened.

## Bound a runaway run

A graph that hangs — a model call with no timeout of its own, a node that loops — holds a worker slot
until the process restarts. Set `--run-timeout <ms>` or `SKEIN_RUN_TIMEOUT_MS`; the run aborts and
settles as `timeout`.

**Off by default, deliberately.** A legitimate research or multi-step tool run takes minutes, so a
default would turn slow-but-working into killed — the exact failure the timeout exists to prevent.
Pick a number from your own graphs' worst honest case.

## Start a run later

`afterSeconds` holds a run before it starts — capped at 86400 (a day); for anything longer use a
[cron](./crons.md).

Use it on a **background** run. The queue holds it, so it costs nothing while it waits and, on Redis,
survives a restart. On an inline `wait`/`stream` run the server holds _your connection_ open instead,
so a long delay will hit a proxy's idle timeout.

A delayed run is cancellable like any other, and counts as inflight the whole time it waits.

## Fields where skein differs from LangGraph

Two defaults are deliberately not LangGraph's. If you're migrating, these are the ones to check:

| Field           | skein      | LangGraph | Why                                                                                        |
| --------------- | ---------- | --------- | ------------------------------------------------------------------------------------------ |
| `on_completion` | `keep`     | `delete`  | A stateless run's thread stays inspectable afterwards                                      |
| `on_disconnect` | `continue` | `cancel`  | A proxy timeout is indistinguishable from a real hang-up, and shouldn't kill a healthy run |

Pass the LangGraph value explicitly if you want its behaviour. Note `useStream` sends
`on_disconnect: "cancel"` on every submit unless the stream is resumable, so with a browser client
closing the tab does stop the run — skein's default only applies to callers that don't send the field.

One more worth knowing, though it matches LangGraph: **naming a thread that doesn't exist is a 404**
(`if_not_exists: "reject"`). Pass `"create"` to have the run bring the thread into existence instead —
which is how you start a run keyed on an external identity (a phone number, a ticket id) without a
round trip to create the thread first.

## Don't create the same run twice

A retrying caller — Stripe, GitHub, Twilio, or your own sweep — should not start a second run. Send an
`Idempotency-Key` header and the original response replays:

```ts
// `runs.create` has no `headers` option — a `headers` key in the payload is silently dropped and you
// get a brand-new run every retry. A per-key client is the only way to send it.
const client = new Client({ apiUrl, defaultHeaders: { "Idempotency-Key": issue.id } });
await client.runs.create(threadId, "agent", { input });
```

Streaming creates reject the header rather than ignoring it — an SSE response has no body to replay.
Details: [agent-protocol.md](./agent-protocol.md#idempotent-run-creation-idempotency-key).

## Reading a run back

| You want                                 | Call                                      |
| ---------------------------------------- | ----------------------------------------- |
| One run's row                            | `client.runs.get(threadId, runId)`        |
| A thread's runs                          | `client.runs.list(threadId)`              |
| To tail a run already in flight          | `client.runs.joinStream(threadId, runId)` |
| To block until it settles, then get JSON | `client.runs.join(threadId, runId)`       |

Joining a run that has **already** settled returns immediately, long after its frames have aged out —
the wait is decided by the run row, not by the event stream. So a client that reconnects late still
gets its answer.

To be told a run finished without holding anything open, use a [webhook](./webhooks.md).

## Working example

[`triage-agent`](https://github.com/skein-js/skein-js/tree/main/examples/triage-agent) dispatches one
background run per issue, each on its own thread, with idempotent re-sweeps — and runs with no API key
and no network.

## See also

- [Streaming](./streaming.md) — stream modes, reconnecting, joining
- [Runs & Redis](./runs-and-redis.md) — run concurrency, the queue, scaling past one instance
- [Human-in-the-loop](./human-in-the-loop.md) — pausing a run for a person
- [Crons](./crons.md) — running a graph on a schedule
- [Agent Protocol](./agent-protocol.md#runs--stateless--ephemeral) — every run endpoint and field
