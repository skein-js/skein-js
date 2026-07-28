# Performance & memory work stream

Working notes for the performance/memory effort started 2026-07-27. Tracking doc, not user-facing —
deliberately outside `docs/` so it stays out of the published set and `llms-full.txt` (the bundle reads
a curated list in `scripts/generate-llms-full.mjs`).

The original plan lives at `~/.claude/plans/for-skein-especially-production-sprightly-fox.md`. This
file is the running state: what shipped, what it measured, what is left, and the context needed to
pick any of it up cold.

## Why this exists

`skein start` (the container) and the embedded-adapter path had never been profiled. An audit found
several unbounded structures on live production paths. The goal: bounded, predictable memory under
concurrent streaming load on both small (256–512Mi, many replicas) and large (1–4Gi) shapes — tunable,
with sane defaults and documented sizing math.

### Decisions already taken

- Search limits capped at **1000** with a `SKEIN_MAX_PAGE_SIZE` escape hatch. Accepted as a behavior
  change.
- Postgres index migrations use **`CREATE INDEX CONCURRENTLY`**, not a documented warning.
- Bun/Deno is an **investigation with a docs deliverable**, not a shipped runtime.
- All 12 phases in scope.

---

## Shipped

| Commit    | Phase | What changed                                    |
| --------- | ----- | ----------------------------------------------- |
| `ffd779f` | P0    | `packages/bench` harness + baseline             |
| `7e63ed8` | P1    | SSE backpressure in all three Node transports   |
| `d1c5ba9` | P3    | In-memory event bus bounded                     |
| `df31b68` | P4    | Redis bus: one round trip/frame, one connection |
| `cac874d` | P2    | Frame-encode cache + replacer fix               |
| `dfb450d` | P5a   | Postgres indexes for list/search paths          |
| `713672b` | P5b   | Opt-in HNSW index                               |

### Measured

- **Per-connection SSE buffer**: ~1.26 MB (the whole stream) → constant ~67 KB (the socket's own
  high-water mark). 100 slow streams: 125.5 MB → 6.5 MB. Throughput and p99 unchanged, no frames lost.
- **Bus retention**: 200 runs left 200 permanent channels holding every frame → 50 channels, 1350
  frames.
- **Redis per frame**: 3 sequential round trips + 2 serializations → 1 pipelined round trip + 1
  serialization. 500 concurrent streams: 501 sockets → 2.
- **Serialization**: ~6% off `serializeWireJson`; frame encode ~48% faster at 2 subscribers, ~73% at 4.

### New knobs

| Variable                              | Default | Bounds                                        |
| ------------------------------------- | ------- | --------------------------------------------- |
| `SKEIN_MEMORY_BUS_MAX_FRAMES_PER_RUN` | 10000   | Frames one run may buffer (hard max)          |
| `SKEIN_MEMORY_BUS_MAX_RETAINED_RUNS`  | 50      | Finished runs replayable for a late `join`    |
| `SKEIN_REDIS_STREAM_MAXLEN`           | 10000   | Approximate cap on a run's Redis stream       |
| `SKEIN_STREAM_BUFFER_FRAMES`          | 512     | Frames one subscriber may queue before ending |

---

## Remaining

### P6 — query bounds, pool tuning, thread history, auth pushdown

**The highest-value work left.** Four separable commits.

**6a — pool options.** `createPostgresPool` (`packages/storage-postgres/src/postgres-skein-store.ts`)
sets only `max` and `ssl`. No `idleTimeoutMillis`, `connectionTimeoutMillis`, `keepAlive` — so a wedged
database hangs a request forever with no connect timeout. Extend `postgresConnectionOptions()` in
`packages/runtime/src/drivers.ts`, which already does this shape for `PG_POOL_MAX`. Surface on
`EmbedPostgresGraphsOptions` too. Suggested: `PG_IDLE_TIMEOUT_MS` 30000 (small shape 10000),
`PG_CONNECTION_TIMEOUT_MS` 10000. Pure win.

**6b — bound the unbounded queries.** Cap at 1000 with `SKEIN_MAX_PAGE_SIZE`:

- `threadSearchSchema` (`packages/agent-protocol/src/validation/schemas.ts:116-122`) and
  `storeSearchSchema` (`:206-210`) have `limit: z.number().int().positive().optional()` — no `.max()`,
  no default. `assistantSearchSchema` (`:157-162`) already caps at 1000; match it.
- `threads.list` (`postgres-skein-store.ts` ~755) is `SELECT * FROM threads ORDER BY created_at` with
  no LIMIT — and `threads.values` is the **full mirrored graph state per row**.
- `threads.search` (~794): `limitClause` is empty when `limit` is undefined. Absent limit must mean
  "first 1000", applied in the driver so `list` is covered too. Both drivers change together
  (conformance suite).
- Non-semantic store search (~1059): no LIMIT/OFFSET pushdown — loads the whole table then
  `.filter(JSON.stringify(value).toLowerCase().includes(needle))` and `.slice()` in JS. Push down for
  the no-`query` case (identical rows, pure win). For the `query` case, `value::text ILIKE` is **not**
  equivalent — jsonb `::text` canonicalizes key order and whitespace — so align both drivers on one
  normalized text, covered by the conformance suite.

Clients detect truncation via `x-pagination-total`, already in the always-exposed CORS header list.

**6b-bis — bound thread history. Highest single-request win.**
`packages/agent-protocol/src/create-handlers.ts:287-291` passes `options: undefined` when no `limit`
query param is given, and `thread-service.ts:141-149` then drains `graph.getStateHistory()` to
exhaustion, pushing **every checkpoint's full `values`** into one array, which is then
`serializeWireJson`'d into one response string. A 200-turn thread materializes its entire state history
plus that string at once. `positiveIntQuery` has no cap either, so `?limit=1000000` is accepted.
Unauthenticated by default.

Default the limit to **100** (smaller than the search cap — each element is a full graph state, not a
row), clamp to `SKEIN_MAX_PAGE_SIZE`, and pass it into `graph.getStateHistory({ limit })` rather than
draining and breaking, so the checkpointer stops fetching too.

**6c — push the auth ownership filter into SQL.** Own commit.
`packages/agent-protocol/src/auth/auth-scoped-store.ts:62-73` strips `limit`/`offset`, fetches every
matching thread (each with full `values`), filters in JS, then slices. `AuthFilters` map cleanly:
`$eq`/string → `metadata @> $n::jsonb`; `$contains` → `metadata->k ? v`. Add an internal
`metadataFilters` to `ThreadSearchQuery`, implement in both drivers, keep the JS filter as a
belt-and-braces conformance assertion. **The GIN indexes from `dfb450d` already exist**, so this turns a
full table scan into an index lookup — the largest memory win on the auth path.

### P7 — `statement_timeout` on by default

Deliberately a **separate release** after P6 has baked. Turning it on before the bounds and indexes
exist converts today's slow-but-working `threads.search` into a hard error.
`PG_STATEMENT_TIMEOUT_MS` default 30000 (small 15000 / large 60000), `=0` disables.

### P8 — bundle & boot footprint

`@langchain/langgraph-api` + `@typescript/vfs` land in **every** adapter bundle regardless of on-ramp,
contradicting the promise in `docs/bundling.md:57-60`. Two causes, both needed:

1. `packages/server-kit/src/resolve-runtime.ts:17` statically imports `loadInMemoryRuntime`, used in a
   live conditional at `:142-144`. Make it `await import()` in the else branch.
2. `run-concurrency.ts:10` and `shutdown-grace.ts:10` import `SkeinConfigError` from the **single-entry**
   `@skein-js/config` barrel, whose `dist/index.js` opens with
   `import { getStaticGraphSchema } from "@langchain/langgraph-api/schema"`. Both resolvers run on every
   path. Add a `./errors` subpath export to `@skein-js/config` (second tsup entry) and import from
   there. Rejected alternatives: moving the class to `@skein-js/core` inverts the documented layering;
   throwing a different error type is observable (both `.test.ts` files assert on it).

Also: move `readLanggraphDevState`/`loadSnapshotIntoStore`/`describeSnapshot` (which drag `superjson`,
`zod`, `node:fs/promises` into the same barrel as `embedInMemoryGraphs`) to a
`@skein-js/server-kit/dev` subpath — consumers are only `cli/src/import-command.ts`, `dev-command.ts`,
and a re-export at `server-express/src/index.ts:37-39`. **No deprecated root re-export**: a re-export is
still a static import and defeats the point. And dynamic-import `@langchain/langgraph-api/schema` at
its one call site (`config/src/load-config.ts:164`) so `staticSchemas` production boots never load it.

Guard it with a new `packages/test-support/src/static-imports.test.ts` modelled on the existing
`package-exports.test.ts`: read each adapter's `dist/index.js`, extract top-level import specifiers,
assert none matches `@skein-js/config`, `@langchain/langgraph-api`, or `superjson`. That test is what
stops this regressing.

### P9 — CLI & container

1. **`skein start` must hard-require durable drivers.** `packages/cli/src/index.ts:110-111` defaults
   both `--store` and `--queue` to `memory`; only the generated Dockerfile CMD flips them, so any CMD
   override yields an unbounded in-memory production server whose state vanishes on restart. Give
   `start` its own `parseChoice(["postgres"])` / `parseChoice(["redis"])`, default the flags to the
   durable values, **keep the flags** (older images pass them in CMD), and make the rejection name
   `skein dev` as the no-infrastructure alternative. Consistent with `readBakedSchemas`, which already
   hard-fails `start` outside a built artifact. **Removes** `--store postgres --queue memory`; that
   topology stays supported via `embedPostgresGraphs`, where it is documented. Nothing in the repo
   depends on the old default — there is no `start-command.test.ts`.
2. Base image `node:20-slim` → `node:22-slim`. Node 20 went EOL April 2026.
3. **No hardcoded heap size** — the Dockerfile cannot know the container limit. Log
   `v8.getHeapStatistics().heap_size_limit` against `/sys/fs/cgroup/memory.max` at boot, warning above
   ~75%. Keep `NODE_OPTIONS` as the documented override.
4. `HEALTHCHECK --interval` 30s → 60s (it spawns a whole Node process, ~40MB transient in a 512Mi box)
   and document that Cloud Run/k8s/ECS use their own probes and ignore it.
5. `express.json()` is pinned at the default 100kb with no override — add `json?: { limit?: string }`.
6. `--request-log` / `SKEIN_REQUEST_LOG`, on for `dev`, **off** for `start`: `start-command.ts:132`
   always passes a logger for failure reporting, which silently also enables 2 log lines per request.
7. Warn at boot when `runConcurrency > PG_POOL_MAX`.

### P9b — runtime heap-pressure detection

Bounding leaks is not knowing when a deployment is near its ceiling; today the first signal is an OOM
kill, which on Cloud Run/k8s looks like an unexplained restart. Add
`packages/server-kit/src/heap-pressure.ts`: sample `v8.getHeapStatistics()` on a 30s
`setInterval().unref()`, warn **once per threshold crossing** with hysteresis (warn at 85%, re-arm
below 70%) — a monitor that logs every 30s under sustained pressure gets filtered out.

The payload is what makes it useful: heap used/limit, RSS, container limit, in-flight run count, active
SSE subscriber count, and `bufferedFrameCount` from the bus. That combination distinguishes "too many
concurrent runs" from "one slow client buffering" from "a genuine leak". Emit through the injected
`Logger` and, when telemetry is on, as a `TelemetrySink` gauge. `SKEIN_HEAP_WARN_PERCENT` (85, `0`
disables), `SKEIN_HEAP_SAMPLE_MS` (30000). Test with an injected `heapStatistics` reader and fake clock.

### P10 — run timeout & webhook

1. `deps.runTimeoutMs` exists in the engine (`run-engine.ts:262-265`) but **no CLI flag or env var
   reaches it**, so production runs have no wall-clock ceiling. Add
   `packages/server-kit/src/run-timeout.ts` following `run-concurrency.ts`; default **unset** (opt-in —
   defaulting it would kill long graphs).
2. `fetchWebhookDispatcher` (`deps.ts:155-178`) has no `AbortSignal`. Add
   `AbortSignal.timeout(...)`, `SKEIN_WEBHOOK_TIMEOUT_MS` default 10000.
3. **Hoist webhook dispatch out of the thread lock.** `run-engine.ts:484-500` awaits delivery in
   `executeRun`'s `finally`, which runs inside `executionLocks.run(threadId, …)` — so a hung target
   blocks every other run on that thread and holds `outcome.values` (the whole graph state) alive. Move
   it to `startRunExecution` after the lock releases, still awaited so shutdown cannot exit mid-delivery.
   Test with a dispatcher that never resolves, asserting a second run on the same thread acquires the
   lock.

### P11 — docs

**New `docs/performance.md`** is warranted: the knobs span five packages and `deploy.md`'s "Sizing &
tuning" is already ~300 lines. It should own the sizing math per shape, **one table of every knob**
(env / flag / option / default / small / large), backpressure and drop semantics with `Last-Event-ID`
recovery, a symptom→knob triage table, and how to run the benchmark.

Updates needed: `deploy.md` (link out), `runs-and-redis.md`, `storage.md`, `embedding.md`,
`bundling.md`, `streaming.md`, `testing.md` (the assertion patterns below). Register new pages in
`docs/index.md`, `llms.txt`, the README doc table, and `scripts/generate-llms-full.mjs`, then run
`pnpm docs:llms`.

Known stale spots: `docs/bundling.md:57-60` (fixed by P8), `packages/bench/README.md:4` links to
`docs/performance.md` which does not exist yet, and `docs/langgraph-cli-compat.md` omits
`store.index.hnsw` from the compat table.

### P12 — Bun/Deno spike

Time-boxed to 2 days; deliverable `docs/alternative-runtimes.md` **whether the answer is yes or no** — a
documented negative stops the question recurring.

**Run it after P1–P4 (done), which it now is.** Benchmarking against a leaky baseline would only
measure which runtime buffers garbage more efficiently.

Favourable signals, all verified: no `cluster`, no `worker_threads`, no native addons; `pg`/`ioredis`/
`bullmq` pure JS; Express 5; schemas precomputed at build time so the image never spawns
langgraph-api's parser worker; `vite` lazily imported and absent from the image. Bun 1.3.14 and Deno
2.9.4 are installed locally.

Test in order, stopping at the first hard failure:

1. **`AsyncLocalStorage` fidelity — the gate.** `@langchain/core` uses ALS for callback singletons. The
   probe is not "does ALS exist" but whether `graph.streamEvents(…, { version: "v2" })` emits
   correctly-parented events: a graph with a tool calling a nested chain, asserting `run_id` /
   `parent_ids` / `tags`. Context leaking across awaits means `events` mode silently mis-parents.
2. **`res.write`/`drain` semantics** on each runtime's `node:http` shim. Load-bearing for P1: if
   `write()` does not return `false` past the high-water mark, backpressure is a **no-op** there and
   memory is _worse_ than Node.
3. Full `pnpm test` + `pnpm test:integration`, then the SDK-driven e2e (`examples/express-basic` is the
   wire-format oracle) with the server on Bun/Deno and the client on Node.
4. ioredis handshake-flush lifecycle — the failure `redis-connection.ts` exists to work around;
   unhandled-rejection defaults differ.
5. `process.on("SIGTERM")` as PID 1.
6. P0 harness numbers, same scenarios.
7. Deno specifics: `--allow-net/--allow-env/--allow-read`, `--node-modules-dir`, Express 5 on Deno's
   `node:http`. Expect this to be the harder of the two.

**"Yes" needs all four:** (1) and (2) clean; full suite + SDK e2e green including interrupts and
`events` parenting; SIGTERM drain works as PID 1; and **≥25% RSS reduction or ≥40% boot-time reduction
at equal-or-better p99**.

**Expectation setting.** skein's hot path is I/O-bound (model calls, then Redis/Postgres round trips),
so headline Bun benchmarks do not map. Expect a modest win in baseline RSS — which lands on the
small-container target — and some boot gain that P8 probably beats. No gain on run throughput, and
**none at all on what P1–P7 fix**: a faster runtime does not fix an unbounded buffer, it fills it sooner.

**Does it help the adapters? Mostly no.** They are libraries running in the _user's_ process; skein does
not pick that runtime. The real adapter payoff is the compatibility answer from test 2. A genuine
adapter-level Bun win would be a separate `@skein-js/bun` package on `Bun.serve` — the transport-neutral
handler table makes that cheap later, but it is out of scope.

---

## Working notes

Things learned the hard way. Each cost real time.

**The benchmark harness has two traps.** Both are documented in `packages/bench/README.md`, and both
silently invalidate results:

1. A `fetch`-based slow client is not slow. undici drains the kernel socket into its own buffer as fast
   as the server writes, so the backlog lands client-side and a server with no backpressure reports
   `sseBufferedBytes: 0`. Use the raw paused socket in `slow-socket-client.ts`.
2. A stream must exceed the buffers between the two ends (client stream buffer + both kernel socket
   buffers, a few hundred KB). A 500-frame run at 512 B/frame fits inside them and a broken server looks
   clean.

**The bench loads built `dist`, not `src`.** `packages/bench` resolves `@skein-js/*` through package
`main`, so **rebuild before benchmarking** or you measure the previous commit. This cost an hour chasing
a truncation that had already been fixed — and made instrumentation appear to prove the opposite.

**Assertion patterns** (see `docs/testing.md` once P11 lands). Never assert on `process.memoryUsage()`
in Vitest — it belongs in `packages/bench` as a reported number, never a gate. Instead:

- **Backpressure**: a fake sink with a high-water mark; assert on **how many times the frame iterator
  was pulled**, not on bytes buffered.
- **Redis**: the `createClient` DI seam; assert integer command counts.
- **Memory bus**: the `trackedChannelCount` / `bufferedFrameCount` accessors.
- **Bundle**: read `dist/index.js` and assert on top-level import specifiers.
- **Postgres**: Testcontainers + `pg_indexes` catalog assertions and `EXPLAIN`.

**Async generators cannot be force-returned while parked on an `await`.** `return()` is only honoured at
a yield point, so a generator waiting on a bus waiter stays parked. The SSE transports fire-and-forget
that call for this reason — tests must too, or they hang.

**Review cadence: one round per commit.** Three rounds on a single phase produced a genuine loop. Round
1 caught serious defects (silent frame loss, a permanent hang, a missed call site, data corruption from
a fractional config value); round 3 caught a weak test and stale docs. Re-review only when a fix is
large enough to be its own change. And **verify a reported defect before acting** — reviewers are
usually right but not always (one divided a per-socket figure by idle connections and reported it 2× off).

**Claims in comments and docs must match the code.** Two caught in review: I wrote that the memory frame
cap "matches Redis `MAXLEN`" when Redis had no `MAXLEN` at all (only a 1h TTL) — having verified that
myself earlier — and a test comment claimed a guarantee the test could not observe.

## Verification

Per phase, before commit (AGENTS.md golden rule 4; `/commit` runs it):

```bash
pnpm affected                                    # lint · test · typecheck · build for what changed
nx run-many -t build test-integration            # Docker-backed, needed for P6–P7
```

`example-chat-app:test` fails without a live Gemini key. That is pre-existing and excluded from the
commit hook — use `--exclude='example-*'` when running `affected` by hand.

End to end:

```bash
nx build bench && nx bench bench                 # slow-client RSS must plateau as --streams rises
nx bench bench -- --driver postgres-redis        # needs Docker
```

The numbers that prove the streaming work: slow-client RSS plateaus 1→500 streams; Redis commands per
frame is 1, not 3; `busTrackedChannels` stays at `maxRetainedRuns`; and (after P8) the static-import
guard shows `@langchain/langgraph-api` absent from every adapter bundle.

Manual smoke on the real image, since the container contract changes in P9:

```bash
skein build && docker run -p 8123:8123 -e POSTGRES_URI=… -e REDIS_URI=… <tag>
# then docs/deploy.md's "Verify a deployment" script — especially step 4, the background run
```

## Release notes to write

At 0.11.3 these are minor bumps by semver-zero convention, but each needs an explicit `CHANGELOG.md`
entry under a **Behavior changes** heading:

- **P3** — memory bus replay window shrinks (1000 retained runs → 50); a subscriber that falls behind
  `MAX_FRAMES_PER_RUN` has its stream ended rather than being handed a gap.
- **P4** — Redis stream trimmed at `MAXLEN`; a subscriber past `STREAM_BUFFER_FRAMES` is ended;
  subscribers now share one connection (a shared failure domain).
- **P5** — `0005` builds indexes concurrently at boot; HNSW is approximate and pins the embedding
  column when enabled.
- **P6** — **`threads.search` truncates at 1000** and `/history` defaults to 100. The one most likely
  to surprise someone.
- **P8** — root exports move to `/dev` and `/errors` subpaths.
- **P9** — **`skein start` refuses memory drivers**; Node 22 base image; request logs off under `start`.
- **P10** — slow webhook targets now fail instead of hanging a thread lock.
