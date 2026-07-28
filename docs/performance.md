# Performance & memory

How skein behaves under load, what bounds it, and which knob to reach for when something looks wrong.

The short version: **every buffer in skein is bounded, and every bound has a knob.** The defaults are
chosen so an ordinary deployment never loses a frame or truncates a page, which means they are not
chosen to fit a small container. If you run on 256–512Mi, read [Sizing](#sizing) — a handful of knobs do
almost all the work.

## Contents

- [What actually uses memory](#what-actually-uses-memory)
- [Sizing](#sizing)
- [Every knob](#every-knob)
- [Streaming: backpressure, drops, and recovery](#streaming-backpressure-drops-and-recovery)
- [Query bounds](#query-bounds)
- [Triage: symptom → knob](#triage-symptom--knob)
- [Measuring it yourself](#measuring-it-yourself)

## What actually uses memory

Four things, in the order they matter:

1. **Run frames in flight.** A streaming run produces frames faster than a client consumes them. Those
   frames live in the event bus until every subscriber has read them, and under `stream_mode: "values"`
   each frame is a copy of the whole graph state. This is the biggest and the most variable.
2. **Socket write buffers.** Every SSE connection whose client is slower than the graph. Bounded to the
   socket's own high-water mark (~64KB) — see [backpressure](#streaming-backpressure-drops-and-recovery).
3. **Rows read by one request.** A thread row carries the thread's mirrored graph state, so a search
   that returns 1000 threads is 1000 graph states, twice over (the rows, then the serialized response).
4. **The runtime itself.** ~130MB RSS to import an adapter and start a server, dominated by
   `@langchain/core` and `@langchain/langgraph`. This is a floor, not a variable — see
   [bundling.md](./bundling.md).

Runs themselves are cheap when idle: a queued run is a row, not a process.

## Sizing

### Small: 256–512Mi, many replicas

The shape most platforms default to. The defaults do **not** fit here — they are sized so a long,
chatty run never loses a frame, and the worst case is roughly
`MAX_FRAMES_PER_RUN × (concurrent runs + MAX_RETAINED_RUNS)`. At the defaults that ceiling is half a
million frames.

```bash
SKEIN_RUN_CONCURRENCY=3
SKEIN_MEMORY_BUS_MAX_FRAMES_PER_RUN=2000    # only when queue=memory
SKEIN_MEMORY_BUS_MAX_RETAINED_RUNS=20       # only when queue=memory
SKEIN_STREAM_BUFFER_FRAMES=128              # only when queue=redis
SKEIN_MAX_PAGE_SIZE=200
PG_POOL_MAX=5
PG_STATEMENT_TIMEOUT_MS=15000
```

Worked example, 512Mi with Redis: the runtime floor is ~130MB. Three concurrent runs, each with one SSE
subscriber, buffer at most `3 × 128` frames in this process; at ~2KB per frame that is under a megabyte.
The store pool holds 5 connections, the checkpointer pool another 5. A `POST /threads/search` returns at
most 200 threads. That leaves the bulk of the container for the graph's own working set — which is where
you actually want it, and which skein cannot size for you.

Below ~345Mi also check [the heap-limit warning](./deploy.md#heap-size-vs-the-containers-memory-limit):
Node's automatic heap sizing has a floor and stops adapting there.

### Large: 1–4Gi, high concurrency

The defaults are close to right; raise concurrency to match the database.

```bash
SKEIN_RUN_CONCURRENCY=25
PG_POOL_MAX=30              # ≥ concurrency, and skein opens TWO pools per instance
SKEIN_REDIS_STREAM_MAXLEN=50000
SKEIN_STREAM_BUFFER_FRAMES=2048
PG_STATEMENT_TIMEOUT_MS=60000
```

**Budget two pools per instance** (store + checkpointer), so 25 concurrency at `PG_POOL_MAX=30` is 60
connections against your database's cap, per replica. `skein start` warns at boot when concurrency
exceeds `PG_POOL_MAX`, because the symptom otherwise is flat throughput with nothing pointing at the
pool.

### The one that isn't about size

`SKEIN_RUN_TIMEOUT_MS` is off by default and stays off unless you set it. A legitimate agent run takes
minutes; a research or multi-step tool graph takes longer. A default here would turn slow-but-working
into killed. Set it from your own graphs' worst honest case, not from a round number.

## Every knob

Defaults are what skein uses when the variable is unset. "Small" and "Large" are the starting points
above, not requirements.

### Runs

| Variable                                      | Default | Small | Large | What it bounds                                                    |
| --------------------------------------------- | ------- | ----- | ----- | ----------------------------------------------------------------- |
| `SKEIN_RUN_CONCURRENCY` / `N_JOBS_PER_WORKER` | 10      | 3     | 25    | Queued runs one instance executes at once (`--concurrency`, `-n`) |
| `SKEIN_RUN_TIMEOUT_MS`                        | off     | off   | off   | Abort a run executing longer than this (`--run-timeout`)          |
| `SKEIN_SHUTDOWN_GRACE_MS`                     | 5000    | 5000  | 15000 | How long `SIGTERM` lets in-flight runs finish before aborting     |
| `SKEIN_WEBHOOK_TIMEOUT_MS`                    | 5000    | 5000  | 5000  | One webhook POST. Sized to the shutdown budget — raise both       |

### Streaming

| Variable                              | Default | Small | Large | What it bounds                                            |
| ------------------------------------- | ------- | ----- | ----- | --------------------------------------------------------- |
| `SKEIN_MEMORY_BUS_MAX_FRAMES_PER_RUN` | 10000   | 2000  | 10000 | Frames one run may buffer — in-memory bus only            |
| `SKEIN_MEMORY_BUS_MAX_RETAINED_RUNS`  | 50      | 20    | 200   | Finished runs still replayable to a late `join`           |
| `SKEIN_REDIS_STREAM_MAXLEN`           | 10000   | 2000  | 50000 | Approximate cap on a run's Redis stream (`0` = TTL only)  |
| `SKEIN_STREAM_BUFFER_FRAMES`          | 512     | 128   | 2048  | Frames one slow subscriber may queue before being dropped |

The socket write buffer has no knob: the socket's own high-water mark sets it, and nobody could size a
second one sensibly.

### Storage

| Variable                   | Default    | Small | Large | What it bounds                                         |
| -------------------------- | ---------- | ----- | ----- | ------------------------------------------------------ |
| `SKEIN_MAX_PAGE_SIZE`      | 1000       | 200   | 1000  | Largest page any list/search returns                   |
| `PG_POOL_MAX`              | pg's 10    | 5     | 30    | Connections per pool — skein opens two per instance    |
| `PG_CONNECTION_TIMEOUT_MS` | 30000      | 30000 | 30000 | Waiting for a free connection (`0` = wait forever)     |
| `PG_IDLE_TIMEOUT_MS`       | pg's 10000 | 10000 | 30000 | How long an unused pooled client is kept               |
| `PG_STATEMENT_TIMEOUT_MS`  | 30000      | 15000 | 60000 | One statement server-side (`0` = off). Not per request |

### Diagnostics

| Variable                  | Default | What it does                                                       |
| ------------------------- | ------- | ------------------------------------------------------------------ |
| `SKEIN_HEAP_WARN_PERCENT` | 85      | Warn above this % of the heap limit (`0` disables the monitor)     |
| `SKEIN_HEAP_SAMPLE_MS`    | 30000   | How often the heap monitor samples                                 |
| `SKEIN_REQUEST_LOG`       | see doc | A line per HTTP request. On for `skein dev`, off for `skein start` |

Most of these can also be set in code — `worker: { maxConcurrency, shutdownGraceMs }` on any adapter,
`embedPostgresGraphs`' options, `runTimeoutMs` on the deps, or a store constructor. Where a code path
exists, the environment is still read **and validated** even when you pass the option, so a typo fails at
boot rather than sitting unnoticed in a deployment that also passes the value.

Four are environment-only: `SKEIN_WEBHOOK_TIMEOUT_MS`, `SKEIN_REQUEST_LOG` (or the CLI flag), and the two
Redis stream bounds — setting those in code means constructing `RedisRunEventBus` yourself. The webhook
timeout and the request-log switch also _fall back_ on a malformed value rather than throwing: both sit on
paths where refusing to boot would be the more damaging failure.

## Streaming: backpressure, drops, and recovery

**Backpressure.** The SSE write loop waits for the socket to drain before pulling the next frame, so a
slow client's unwritten bytes stay in the socket's own buffer (~64KB) instead of accumulating in the
process. Measured: a slow consumer's per-connection buffer went from ~1.26MB (the whole stream) to a
constant ~67KB; 100 slow streams went from 125.5MB to 6.5MB, with no change to throughput or p99 and no
frames lost. The graph does not slow down — the bus decouples it from the socket.

**Drops.** Backpressure moves the problem rather than solving it: the frames queue in the bus instead.
So the bus is bounded too, and a subscriber that falls behind the bound has its stream **ended** rather
than being handed a silent gap.

**Recovery.** An ended stream is not a lost run. Reconnect with `Last-Event-ID` and skein replays from
that point — from the in-memory buffer, or from the Redis stream, whichever bus you run. The LangGraph
SDK's `joinStream` does this for you. What you cannot recover is a frame that has aged out of
`SKEIN_REDIS_STREAM_MAXLEN` or been evicted from the in-memory buffer, which is why those bounds are the
ones to raise if reconnecting clients see gaps.

**Retention after a run ends.** A finished run's frames stay replayable so a late `join` still works —
for `SKEIN_MEMORY_BUS_MAX_RETAINED_RUNS` runs on the in-memory bus, or until the stream's TTL on Redis.
Beyond that, joining a finished run completes immediately with no frames rather than hanging.

See [streaming.md](./streaming.md) for the wire format and [runs-and-redis.md](./runs-and-redis.md) for
what a frame costs in Redis.

## Query bounds

Every list and search path is bounded — **including when the caller passes no `limit` at all**. Before
that, one `POST /threads/search` with an empty body pulled an entire table into the heap and then
serialized it into a single response string.

- A client-supplied `limit` above 1000 is rejected.
- An absent `limit` means the first `SKEIN_MAX_PAGE_SIZE` rows, not all of them.
- `POST /threads/{id}/history` returns 100 checkpoints by default, capped at 1000, and pages with
  `before`. Each element is a checkpoint's whole graph state, so this is bounded harder than a row-based
  page — and separately from `SKEIN_MAX_PAGE_SIZE`, since history comes from the checkpointer rather
  than the store.
- Truncation is **not** signalled on the response. Page with `offset` until you get fewer rows than you
  asked for, and page by what you received rather than by what you requested.

With auth configured, the ownership filter is pushed into the driver query, so a tenant's search is an
indexed lookup rather than a full read filtered in JS. Details in [storage.md](./storage.md) and
[agent-protocol.md](./agent-protocol.md#authentication--authorization).

## Triage: symptom → knob

| Symptom                                                  | Likely cause                                      | What to do                                                                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restarts with no stack, no log line, nothing in metrics  | OOM kill                                          | Check the boot warning; below ~345Mi see [heap sizing](./deploy.md#heap-size-vs-the-containers-memory-limit). Then lower `SKEIN_RUN_CONCURRENCY` and the bus bounds.                          |
| `heap pressure` warning, high `runs in flight`           | Too much work at once                             | Lower `SKEIN_RUN_CONCURRENCY`, or scale out.                                                                                                                                                  |
| `heap pressure` warning, high `buffered frames`          | A slow SSE consumer                               | Lower `SKEIN_MEMORY_BUS_MAX_FRAMES_PER_RUN`, or move to Redis so frames live outside the process.                                                                                             |
| `heap pressure` warning, neither, across episodes        | A genuine leak                                    | Capture a heap snapshot. Please open an issue.                                                                                                                                                |
| Throughput flat, adding concurrency does nothing         | Runs queuing on the Postgres pool                 | Raise `PG_POOL_MAX` to ≥ concurrency (×2 for both pools). `skein start` warns about this at boot.                                                                                             |
| Requests hang, then fail late                            | Unreachable or wedged database                    | `PG_CONNECTION_TIMEOUT_MS` bounds the wait; `PG_STATEMENT_TIMEOUT_MS` bounds one query.                                                                                                       |
| A query errors with `57014`                              | Statement timeout                                 | The query is scanning something. Deep `OFFSET`, an unindexed `values` filter, or a very large checkpoint history — see [deploy.md](./deploy.md). Raise the timeout only after checking which. |
| Streaming clients see gaps after reconnecting            | Frames aged out before the reconnect              | Raise `SKEIN_REDIS_STREAM_MAXLEN` (or the memory bus's frame bound).                                                                                                                          |
| A stream ends early under load, on **Redis**             | The subscriber's mailbox overflowed               | Raise `SKEIN_STREAM_BUFFER_FRAMES`, or fix the consumer. `Last-Event-ID` recovers it from the durable stream.                                                                                 |
| A stream ends early under load, on the **in-memory bus** | Frames were evicted out from under the subscriber | Raise `SKEIN_MEMORY_BUS_MAX_FRAMES_PER_RUN`. Reconnecting resumes with a gap — the buffer _is_ the replay log. `SKEIN_STREAM_BUFFER_FRAMES` does nothing here.                                |
| Searches return fewer rows than expected                 | The page bound                                    | Expected — page with `offset`. Raise `SKEIN_MAX_PAGE_SIZE` only if you know the rows are small.                                                                                               |
| One thread's runs all stall behind each other            | A run holding the thread lock                     | Runs on a thread are serialized by design. If it is a hung graph, set `SKEIN_RUN_TIMEOUT_MS`.                                                                                                 |
| Shutdown takes ~8s and kills in-flight work              | The drain window                                  | Raise `SKEIN_SHUTDOWN_GRACE_MS`, and your platform's termination grace with it.                                                                                                               |

## Measuring it yourself

`packages/bench` boots a real skein server in-process, opens real SSE clients against it, and samples
while they stream. It is deliberately not part of `pnpm test` — it takes minutes and needs Docker for the
Postgres/Redis driver.

```bash
nx build bench && nx bench bench                 # all scenarios, in-memory drivers, no Docker
nx bench bench -- --driver postgres-redis        # needs Docker
nx bench bench -- --scenario slow-client --streams 500
```

The measurement that matters is **RSS after idle + a forced GC**, not peak RSS: peak tells you about
churn, retained tells you what is actually held. A slow-client run at increasing `--streams` should
plateau, not climb — that plateau is the whole point of the bounds above.

Alongside it, the counters are deterministic and make a regression provable rather than plausible:
buffered frames, Redis commands per frame, socket `writableLength`, iterator pulls, connections opened.
Those are integers with no timing in them, which is why they can gate CI where throughput and latency
cannot. See [testing.md](./testing.md) for how the same idea is applied in the unit tests.
