# Profiling and performance tuning Skein

This guide is the practical bridge between “the server feels slow” and an evidence-backed change.
It assumes no profiling experience.

## The four tools and the tuning loop

- A **benchmark** tells you how much: latency, throughput, memory, boot time.
- A **profiler** tells you where: hot functions, allocation sites, retained objects, garbage collection.
- **Telemetry** tells you when and why in production: graph, runtime, queue delay, failures, saturation.
- A **correctness test** tells you whether a faster result is still the same product.

Use the same loop every time:

1. Write an SLO, such as “p99 time to first frame below 250 ms at 100 streams.”
2. Reproduce it with a deterministic graph and fixed container CPU/memory.
3. Warm the runtime, then record a baseline and raw artifacts.
4. Profile the failing interval, not server startup or an idle process.
5. Change one variable.
6. Run protocol/conformance tests and a negative test designed to expose the suspected failure.
7. Repeat the identical benchmark and compare confidence intervals, not one lucky run.

Create a directory per experiment; generated profiles are ignored by Git and production images:

```bash
mkdir -p .profiles/2026-07-31-slow-sse/{before,after}
nx build bench
```

## Reading the numbers

Latency percentiles answer different questions. p50 is the ordinary request. p95/p99 are the tail
your users notice during queueing, GC, pool waits, or a noisy dependency. For streams, record both
**time to first frame** and total duration; an agent that starts responding in 150 ms and finishes in
20 seconds feels different from one silent for 10 seconds.

Throughput is completed requests/second or frames/second. It means little without concurrency and
saturation. Increase concurrency until throughput stops rising; then inspect CPU, event-loop delay,
Postgres pool waits, Redis, and the load generator. The first saturated component is the limit.

Memory has several layers:

- **JS heap used** is live/recent JavaScript data.
- **Heap capacity/limit** is what the collector/runtime reserved or may grow to; it is not usage.
- **RSS** is resident process memory: JS heap plus runtime, native clients, stacks, code, and buffers.
- **Native/external memory** includes socket buffers and runtime allocations outside the JS heap.
- A healthy GC graph is a sawtooth. A leak has a rising _post-GC floor_ after the same work becomes
  unreachable. A bounded cache rises and then plateaus.

For CPU profiles, **self time** is time in the function itself. **Total time** includes callees. High
self time points at the hot implementation; high total but low self time says to descend into its
children. Wide flame-graph boxes consumed more samples. GC width means allocation pressure, not
necessarily that the collector itself is defective.

## Skein’s cross-runtime benchmark

Use deterministic graphs first—no model calls—then repeat with a separate realistic model workload.
The existing harness exercises real HTTP/SSE and can use real Postgres and Redis:

```bash
nx bench bench -- --scenario fast-client
nx bench bench -- --scenario slow-client --streams 1
nx bench bench -- --scenario slow-client --streams 50
nx bench bench -- --scenario slow-client --streams 100
nx bench bench -- --scenario slow-client --streams 500
nx bench bench -- --driver postgres-redis
```

Do not model a slow client with `fetch()` plus delayed reads: the client runtime may eagerly drain the
socket into its own heap. Skein’s slow-client harness pauses a raw socket so the TCP receive window
closes and backpressure reaches the server.

For Node/Bun/Deno comparisons there is **no harness support yet** — `packages/bench` starts the server
inside its own process, so it cannot measure another runtime, and adding an external-target mode is
tracked follow-up work. Today the comparison is a manual procedure: build each production artifact and
run the load generator outside the measured container. Keep identical CPU/memory limits, graph bundle, payloads, Postgres/Redis versions,
telemetry setting, warm-up, sample duration, and runtime image architecture. Record:

- cold boot and readiness;
- p50/p95/p99 and time to first frame;
- requests/s and frames/s;
- RSS, runtime heap values, and settled post-GC memory;
- memory slope at 1/50/100/500 slow streams;
- queue delay and Postgres pool saturation;
- Redis commands, connections, and retained frames;
- telemetry-off versus telemetry-on overhead;
- SIGTERM drain duration and lost terminal states/events;
- a sustained mixed-load soak.

Run at least five measured repetitions after warm-up and report the median plus a 95% confidence
interval. Save raw JSON beside runtime, image digest, CPU model, memory limit, OS/kernel, and commit.

## Node recipes

Profile the built production entry, send representative traffic from another process, then terminate
it cleanly so profiles flush:

```bash
mkdir -p .profiles/node/cpu .profiles/node/heap
node --cpu-prof --cpu-prof-dir=.profiles/node/cpu \
  packages/cli/dist/index.js start --runtime node

node --heap-prof --heap-prof-dir=.profiles/node/heap \
  packages/cli/dist/index.js start --runtime node

node --trace-gc packages/cli/dist/index.js start --runtime node
node --inspect packages/cli/dist/index.js start --runtime node
```

Load `.cpuprofile` in Chrome DevTools’ Performance panel. Load `.heapprofile` in Memory. In an
inspector session, take two heap snapshots only after the same forced-idle/GC point, repeat the
workload between them, and compare retained size and retaining paths. Snapshots pause the process and
can temporarily require roughly another heap’s worth of memory; capture them on a replica you can
remove from traffic.

## Bun recipes

```bash
mkdir -p .profiles/bun/cpu .profiles/bun/heap
bun --cpu-prof --cpu-prof-dir=.profiles/bun/cpu \
  packages/cli/dist/index.js start --runtime bun
bun --heap-prof --heap-prof-dir=.profiles/bun/heap \
  packages/cli/dist/index.js start --runtime bun
```

Bun has separate JavaScriptCore and native heaps. For an instrumented experiment, record
`heapStats()` from `bun:jsc` for JS objects, `Bun.memoryUsage()` for Bun/native allocations, and RSS.
A flat JS heap with rising RSS points away from retained JS objects and toward native/socket buffers.
Bun’s heap profiler can also emit Markdown summaries; follow the options supported by the pinned Bun
version used by the artifact.

## Deno recipes

The production launcher needs explicit access to the artifact, environment, network, system data, and
native dependencies. Deno’s profiler can produce the raw profile, a Markdown report, and an
interactive flamegraph together:

```bash
mkdir -p .profiles/deno/cpu
deno run --allow-net --allow-env --allow-read=. --allow-sys --allow-ffi \
  --cpu-prof --cpu-prof-dir=.profiles/deno/cpu \
  --cpu-prof-md --cpu-prof-flamegraph \
  packages/cli/dist/index.js start --runtime deno

deno run --inspect --allow-net --allow-env --allow-read=. --allow-sys --allow-ffi \
  packages/cli/dist/index.js start --runtime deno
```

Open the SVG directly or load `.cpuprofile` in DevTools. Deno reports transpiled JavaScript line
numbers in CPU profiles, so use function names and sourcemaps to get back to TypeScript.

## Five diagnostic exercises

### 1. SSE backpressure

Run `slow-client` at 1, 50, 100, and 500 streams. Watch server RSS, socket buffered bytes, and bus
frames. Expected: socket bytes and bus retention plateau at configured bounds. Negative verification:
temporarily replace the raw paused client with a fast client—the pressure disappears, proving a fast
client cannot validate slow-client safety.

### 2. Event-bus retention

Run `long-run`, let all clients disconnect, force idle+GC, and inspect retained objects. Expected:
completed-run retention stops at `SKEIN_MEMORY_BUS_MAX_RETAINED_RUNS`, and frames per run stop at
`SKEIN_MEMORY_BUS_MAX_FRAMES_PER_RUN`. A retaining path through a subscription after cancellation is
a leak; a bounded map at its configured ceiling is not.

### 3. Serialization cost

Compare `stream_mode: "values"` with `"updates"` using the same graph. If CPU self time concentrates
in wire serialization and GC grows, reduce full-state frames or payload size. Verify final state and
frame order before accepting the change.

### 4. Postgres pool saturation

Sweep run concurrency through 1/5/10/20 while holding `PG_POOL_MAX=5`, then repeat at 20. Throughput
should flatten and queue time rise when the pool saturates. Raising worker concurrency alone cannot
fix a five-connection bottleneck; remember Skein uses separate store and checkpointer pools.

### 5. Telemetry shutdown leak

Create a test sink that buffers events and whose `flush()` rejects. Send SIGTERM. The test passes only
if `shutdown()` still runs, the other sinks flush, terminal run state is persisted, and the process
exits within the configured grace. This distinguishes exporter failure from lifecycle loss.

## Benchmark traps

- Warm-up/JIT: keep cold start as its own metric; do not mix it into steady state.
- Coordinated omission: a closed-loop generator waits during stalls and under-samples the stall.
- Noisy neighbours and CPU turbo: pin container resources and repeat.
- A weak load generator: if its CPU is full, you measured the client. This is especially easy with a
  fast native Bun server.
- Model/network variance: deterministic graphs establish runtime overhead; model-backed tests answer a
  different question.
- Different hardware, regions, images, database sizes, or TLS paths: not a runtime comparison.
- Average-only reporting: averages hide queue and GC tails.
- Optimizing without a negative verification: a benchmark win can be dropped frames or skipped work.

## Comparing Skein with LangGraph Platform

Treat Platform as a black box. Use the same graph, SDK client, client region, payloads, concurrency,
warm-up, and observation window. Publish raw results and methodology. A “better” claim requires full
protocol correctness plus a reproducible win in p99, memory, throughput, cold start, or operating cost,
with no material regression in the others. If infrastructure cannot be made identical, label the
result as an end-to-end deployment comparison rather than a runtime benchmark.

Official references: [Node CLI profiling](https://nodejs.org/api/cli.html#--cpu-prof),
[Bun benchmarking and profiling](https://bun.sh/docs/project/benchmarking), and
[Deno CPU profiling](https://docs.deno.com/runtime/fundamentals/cpu_profiling/).
