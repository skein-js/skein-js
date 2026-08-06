# @skein-js/bench

Private performance benchmarks for skein-js. Boots a real server, drives real SSE clients against it,
and reports what it costs — in particular what it **keeps**. See [docs/performance.md](../../docs/performance.md).

Not published, and **not part of `pnpm test`**: this package ships no `vitest.config.ts`, so the
`@nx/vite` plugin infers no `test` target for it and `nx run-many -t test` skips it entirely.

## Running

```bash
nx bench bench                                    # all scenarios, in-memory drivers, no Docker
nx bench bench -- --driver postgres-redis         # production drivers (needs Docker)
nx bench bench -- --scenario slow-client --streams 500
nx bench bench -- --help
```

The target passes `--expose-gc`. Without it the settled-memory figures degrade to an upper bound
rather than a measurement, and the harness says so rather than reporting them as if they were exact.

## It exits non-zero when a bound no longer holds

The run ends in either `all bounds hold.` or a list of violations naming the phase each belongs to. The
checks live in [`src/harness/invariants.ts`](src/harness/invariants.ts) and are the reason CI can run
this at all:

| Bound                       | What it proves                                                              |
| --------------------------- | --------------------------------------------------------------------------- |
| SSE buffered bytes / stream | The write path still honours backpressure (P1) rather than holding a stream |
| Tracked bus channels        | Finished runs are still evicted (P3), not retained one channel per run      |
| Buffered frames / channel   | A run's frames are still trimmed at the per-run cap (P3)                    |
| Frames delivered ≥ produced | Backpressure still _delays_ frames rather than dropping them                |

**Only bounds are gated; no number is.** Throughput, p99, and RSS are reported and never asserted —
runner co-tenancy moves them by tens of percent, so a threshold on them either catches nothing or fails
on a busy machine. That is also why the thresholds that do exist are derived from the _failure_ they
catch, with an order of magnitude of headroom, rather than tuned to the current reading: a bound tracking
the healthy value is a bound that fails on noise.

`long-run` opts out of the delivery bound (`expectsCompleteDelivery: false`). It deliberately exceeds the
bus's per-run cap, so eviction ending its streams early is the behaviour under test — asserting complete
delivery there would fail on _correct_ code.

Verify a change to any of this by breaking it deliberately and watching the run go red. A bound that has
never been seen to fail is not known to be connected to anything.

## What it measures

| Metric                | Why it is here                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `RSS peak`            | How much the workload allocates. Churn.                                                                                               |
| `RSS after idle+gc`   | How much it **kept** once the server went quiet and was fully collected. Retention — the number this work stream is about.            |
| `sseBufferedBytes`    | Sum of `writableLength` across live sockets: bytes the server produced that the client has not taken. The direct backpressure signal. |
| `busBufferedFrames`   | Frames the event bus is holding. Appears once the bus exposes its diagnostics; rendered `n/a` before that.                            |
| `frames/s`, p50 / p99 | Throughput and latency. Noisy on shared runners — tracked, never gated.                                                               |
| `boot`                | Deps assembly plus bind. Moves when the bundle/boot work lands.                                                                       |

## Scenarios

- **`fast-client`** — clients keep up. The floor: what the server costs with nothing backing up.
- **`slow-client`** — clients read at ~25 fps against a 500 fps graph. **The test that matters.**
  Memory here must plateau as `--streams` rises; if it scales linearly, backpressure or bus bounding
  is missing.
- **`idle-retention`** — many short runs, then idle. Isolates what the bus retains after runs finish,
  independent of anything still in flight.
- **`long-run`** — runs that exceed the bus's per-run frame cap, so frame eviction actually happens.
  Read `busBufferedFrames` and the settled-memory figures here; **ignore its `frames/s`, `p99`, and
  delivered-frame count**, which are decided by where each reader happened to be truncated and do not
  reproduce.

## Two things the harness has to get right

Both were found the hard way, and both will silently invalidate results if they regress.

**A throttled client must be a raw socket.** The obvious implementation — `fetch` plus a slow
`reader.read()` loop — does not model a slow client. undici drains the kernel socket into its own
buffer as fast as the server writes, so the backlog lands in the _client's_ memory and the server's
socket never fills. Measured that way, a server with no backpressure at all reports
`sseBufferedBytes: 0`. [`slow-socket-client.ts`](src/harness/slow-socket-client.ts) pauses a raw
socket instead, which closes the TCP receive window and puts the backlog where it belongs.

**A stream has to be bigger than the buffers between the two ends.** The client's stream buffer plus
both kernel socket buffers come to a few hundred KB. A 500-frame run at 512 bytes/frame fits inside
them, so nothing is ever forced to queue and a broken server again looks clean. `slow-client` uses
4 KB frames (~2 MB per stream) for exactly this reason.

## Adding a scenario

Add an entry to `SCENARIOS` in [`src/scenarios/scenario.ts`](src/scenarios/scenario.ts). It is data,
not code — the runner, drivers, and report pick it up automatically.

`expectsCompleteDelivery` is the one field that needs a decision rather than a number: `true` unless the
scenario deliberately exceeds a bound that ends streams early, as `long-run` does. Getting it wrong in
the lax direction costs you the delivery gate on that scenario silently, which is the failure mode the
bounds exist to prevent.

Keep the workload deterministic: no model calls, no network, fixed frame sizes and counts. Two runs of
the same scenario must allocate identically, or a diff against a stored baseline means nothing.
