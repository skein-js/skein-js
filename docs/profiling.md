# Profiling and performance tuning Skein

Profile the skein-js application you deploy when runs are slow, memory keeps growing, or throughput
stops improving. Start with one reproducible symptom and measure before changing configuration.

## The four tools and the tuning loop

1. Record the symptom and target: for example, time to first response, completion time, or memory
   after a batch of runs.
2. Reproduce it in a test deployment using your graph, storage, and representative inputs. Use
   controlled model/tool responses first, then repeat with the real dependencies.
3. Record a baseline after warm-up. Measure the client and server separately so a saturated load
   generator is not mistaken for a slow server.
4. Capture a CPU profile for slow execution, or compare heap profiles for retained memory.
5. Change one setting or application behavior, repeat the same workload, and run your
   [project tests](./testing-your-project.md) to check that output and state remain correct.

Use [observability](./observability.md) to distinguish graph/model latency from queue delay and
storage waits. The [symptom-to-setting table](./performance.md#triage-symptom-knob) helps choose a
configuration change once you know the bottleneck.

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

<span id="skein-s-cross-runtime-benchmark"></span>

## Profile your installed server {#skeins-cross-runtime-benchmark}

Run the following commands from your application directory, with `skein-js` installed locally.
Build the production artifact and make its storage services and environment available as you would
for your normal `skein start` command. Append your usual storage flags to the profiler commands if
needed. If you embed skein-js, replace `node_modules/skein-js/dist/index.js start --runtime node` with
your own built server entry point.

Send representative traffic from a separate process while the profile is recording. Stop the server
cleanly so the profile is written. Confirm that your output directory contains a profile before
opening it in your runtime's tools.

The repository's own benchmark fixtures require a skein-js checkout. Their commands and historical
measurements are [contributor reference](https://github.com/skein-js/skein-js/blob/main/docs/testing.md#repository-profiling-fixtures),
not a prerequisite for profiling your application.

## Node recipes

Profile the built production entry, send representative traffic from another process, then terminate
it cleanly so profiles flush:

```bash
mkdir -p .profiles/node/cpu .profiles/node/heap
node --cpu-prof --cpu-prof-dir=.profiles/node/cpu \
  node_modules/skein-js/dist/index.js start --runtime node

node --heap-prof --heap-prof-dir=.profiles/node/heap \
  node_modules/skein-js/dist/index.js start --runtime node

node --trace-gc node_modules/skein-js/dist/index.js start --runtime node
node --inspect node_modules/skein-js/dist/index.js start --runtime node
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
  node_modules/skein-js/dist/index.js start --runtime bun
bun --heap-prof --heap-prof-dir=.profiles/bun/heap \
  node_modules/skein-js/dist/index.js start --runtime bun
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
  node_modules/skein-js/dist/index.js start --runtime deno

deno run --inspect --allow-net --allow-env --allow-read=. --allow-sys --allow-ffi \
  node_modules/skein-js/dist/index.js start --runtime deno
```

Open the SVG directly or load `.cpuprofile` in DevTools. Deno reports transpiled JavaScript line
numbers in CPU profiles, so use function names and sourcemaps to get back to TypeScript.

## Diagnostic checks {#five-diagnostic-exercises}

### 1. SSE backpressure

Compare ordinary clients with deliberately slow readers against your test server. Watch RSS and
connection count at increasing concurrency. Memory should settle within your configured limits;
compare received output and final state to ensure a lower memory reading is not lost work.

### 2. Event-bus retention

Complete a repeatable workload, disconnect clients, and compare memory after the same idle period.
Configured retention can keep a bounded amount of history. A rising retained baseline across repeated
workloads warrants a heap-profile comparison; see [streaming bounds](./performance.md#streaming).

### 3. Serialization cost

Compare `stream_mode: "values"` and `"updates"` with the same graph and inputs. If full-state events
dominate CPU and allocations, reduce event volume or payload size. Verify that your UI still receives
what it needs and that final graph state matches.

### 4. Postgres pool saturation

Increase concurrency gradually while observing database connections and queue delay. When throughput
flattens, check the [connection budget](./deploy.md#connection-budget) before raising concurrency.
Each instance has multiple pools; database capacity must cover all replicas.

### 5. Telemetry shutdown leak

Stop a busy test server gracefully and check that it exits within your configured shutdown budget.
Confirm that expected terminal run state and telemetry arrive. If an exporter delays exit, inspect
its flush behavior and your host's shutdown order; do not infer a completed run from process exit alone.

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
