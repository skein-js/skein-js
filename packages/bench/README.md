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

Keep the workload deterministic: no model calls, no network, fixed frame sizes and counts. Two runs of
the same scenario must allocate identically, or a diff against a stored baseline means nothing.
