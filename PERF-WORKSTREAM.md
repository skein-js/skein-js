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
- Bun/Deno are first-class production targets, but only graduate after their full clean-artifact
  conformance matrices pass.
- P0–P11 shipped. The original P12 spike is replaced by the three-runtime production program below.

---

## Shipped

| Commit    | Phase   | What changed                                    |
| --------- | ------- | ----------------------------------------------- |
| `ffd779f` | P0      | `packages/bench` harness + baseline             |
| `7e63ed8` | P1      | SSE backpressure in all three Node transports   |
| `d1c5ba9` | P3      | In-memory event bus bounded                     |
| `df31b68` | P4      | Redis bus: one round trip/frame, one connection |
| `cac874d` | P2      | Frame-encode cache + replacer fix               |
| `dfb450d` | P5a     | Postgres indexes for list/search paths          |
| `713672b` | P5b     | Opt-in HNSW index                               |
| `be7d550` | P6a     | Postgres pool timeouts                          |
| `6d39d45` | P6b     | Page bound on every list/search                 |
| `91ac7c6` | P6b-bis | Thread-history bound (body-read + real limit)   |
| `d8d313f` | P6c     | Ownership filter pushed into the driver query   |
| `8c4add3` | P7      | `statement_timeout` on by default (30s)         |
| `4b8a3af` | P8      | Adapter module graph: dev-only tooling removed  |
| `9b6ef9c` | P9      | `skein start` durable-only; container hardening |
| `18681bc` | P9b     | Runtime heap-pressure monitor                   |
| `7321cdd` | P10     | Run + webhook timeouts; webhook out of the lock |
| shipped   | P11     | `docs/performance.md` + doc-set updates         |
| active    | P12+    | Node/Bun/Deno production and profiling program  |
| active    | P12m    | First three-runtime measurements + three fixes  |
| active    | P12ci   | Runtime + image matrices in CI; Node 24 LTS     |

### Measured

- **Per-connection SSE buffer**: ~1.26 MB (the whole stream) → constant ~67 KB (the socket's own
  high-water mark). 100 slow streams: 125.5 MB → 6.5 MB. Throughput and p99 unchanged, no frames lost.
- **Bus retention**: 200 runs left 200 permanent channels holding every frame → 50 channels, 1350
  frames.
- **Redis per frame**: 3 sequential round trips + 2 serializations → 1 pipelined round trip + 1
  serialization. 500 concurrent streams: 501 sockets → 2.
- **Serialization**: ~6% off `serializeWireJson`; frame encode ~48% faster at 2 subscribers, ~73% at 4.

### New knobs

| Variable                              | Default  | Bounds                                        |
| ------------------------------------- | -------- | --------------------------------------------- |
| `SKEIN_MEMORY_BUS_MAX_FRAMES_PER_RUN` | 10000    | Frames one run may buffer (hard max)          |
| `SKEIN_MEMORY_BUS_MAX_RETAINED_RUNS`  | 50       | Finished runs replayable for a late `join`    |
| `SKEIN_REDIS_STREAM_MAXLEN`           | 10000    | Approximate cap on a run's Redis stream       |
| `SKEIN_STREAM_BUFFER_FRAMES`          | 512      | Frames one subscriber may queue before ending |
| `PG_CONNECTION_TIMEOUT_MS`            | 30000    | Wait for a pool connection (`0` = forever)    |
| `PG_IDLE_TIMEOUT_MS`                  | pg's 10s | How long an unused pooled client is kept      |
| `PG_STATEMENT_TIMEOUT_MS`             | 30000    | Ceiling on one statement (`0` = off)          |

---

## Remaining

### P6 — query bounds, pool tuning, thread history, auth pushdown

**The highest-value work left.** Four separable commits.

**6a — pool options. DONE** (see the shipped table). Two things review caught that are worth
remembering if this area is touched again, because neither is obvious:

- A `statement_timeout` must **not** reach the clients that run migrations or pgvector setup. Schema DDL
  is legitimately slow, and a cancelled `CREATE INDEX CONCURRENTLY` leaves an _invalid_ index that the
  retry's `IF NOT EXISTS` matches by name and skips — so the migration records as applied while the
  index goes permanently unused. Both paths now `SET statement_timeout = 0` on their own client.
- It is applied with a `SET` on connect, not as a startup parameter: PgBouncer and Supabase's pooler
  _reject_ unrecognised startup parameters, so every connection would fail rather than degrade. Under
  transaction pooling the `SET` silently does not persist — a backstop, not a guarantee.
- `connectionTimeoutMs` also bounds waiting for a **free client** when the pool is at `max`, not just
  the handshake. That is why the default is 30s rather than 10s: a tighter bound fails a burst against a
  small `PG_POOL_MAX` and an autosuspended serverless Postgres waking on the boot path.

**6b — bound the unbounded queries. DONE** (see the shipped table). `SKEIN_MAX_PAGE_SIZE` (default
1000, resolved by `server-kit/src/max-page-size.ts`) bounds every list/search in both drivers, including
one with **no** `limit`; `threadSearchSchema`/`storeSearchSchema` cap a client-supplied `limit` at 1000.
Measured on 300k threads: `POST /threads/search {}` went 202 ms / 605k buffers → 0.67 ms / 1.9k buffers,
same index, no plan flip on any of the four shapes that could have flipped.

Five things review caught that are worth keeping, because each was invisible in the diff:

- **A page bound silently breaks any read used as _logic_ rather than as a page.** Two such reads
  existed. The auth-scoped store deliberately stripped `limit`/`offset` to get every row before
  filtering by ownership, so with a bound a tenant whose threads sit past row 1000 saw **zero** of their
  own threads and no `offset` could reach them. And `delete_threads` chose its cascade set from an
  unbounded search, so it deleted one page and then deleted the assistant row — leaving the rest
  orphaned _and_ unreachable, since the endpoint then 404s. Both now drain pages via
  `agent-protocol/src/store/collect-pages.ts`. **Grep for reads with no `limit` before bounding anything
  else.**
- `collectPages` reads the page **stride off the first page**, never from what it requested: a driver
  clamps the requested limit to its own bound, so assuming the requested size makes every page look
  short and the drain stops after one. That is the bug the helper exists to prevent, and it is why the
  helper exists at all rather than a two-line loop at each call site.
- **Bounding the response is not bounding the work.** The memory driver's searches still `readAll`'d —
  deep-cloning the whole table — and then sliced, so the "one request materializes a table" property
  survived on the default dev/embedded driver. Filter and sort over the stored references; clone only
  the page (`clonePage`).
- `Number.isInteger` is the wrong validator for a count. `SKEIN_MAX_PAGE_SIZE=1e21` passed boot and then
  failed **every** query (`pg` stringifies it as `1e+21`, which is not a bigint). `requirePositiveInteger`
  now uses `Number.isSafeInteger`, and `requireValidMaxPageSize` in core guards the constructors too —
  a non-positive bound makes the memory driver return empty results with no error at all.
- **Cross-driver row identity under a truncated page is not assertable on ties.** Postgres stores
  `created_at` at microsecond resolution and exposes it at millisecond resolution, so rows that look tied
  to a test are strictly ordered in the database. The id tiebreaker is a within-driver determinism
  contract, not a parity one — the conformance case forces timestamps apart instead.

Not done, deliberately: `x-pagination-total` **does not exist**. `ProtocolResponse` has no headers
channel (`create-handlers.ts:52-55`), and the header appears only in the CORS exposed-headers list. So
truncation is currently undetectable by a client — page by what you _received_. Adding it needs a
`headers` field on `ProtocolResponse` plus every adapter, which is its own change.

`POST /store/namespaces` and `GET /threads/{id}/runs` were on this list and are **now bounded** (P12ci):
both take `limit`/`offset` through to the driver and default to a 100-row page —
`DEFAULT_COLLECTION_PAGE_SIZE` in `create-handlers.ts`, matching what the SDK itself sends for
`listNamespaces`. `GET /threads/{id}/runs` clamps a query `limit` rather than rejecting it, like every
other query-string limit in that table. **With auth configured the runs bound still does not reach
SQL** — `auth-scoped-store.ts` reads the thread's runs, filters by ownership, then slices — which is
the same "bounding the response is not bounding the work" trap 6b documented, and the next thing to fix
here (the `enforcedMetadata` pushdown 6c established for threads).

Still unbounded, all pre-existing and reachable unauthenticated: `runs.listByThread` as called
_internally_ by `loadThreadGraph` on every state read (the HTTP path is bounded now, that one is not),
non-semantic store search **with** a `query` string and no `store.index` configured, and `offset` itself
(uncapped, and a deep offset still walks the index — 137 ms measured at `OFFSET 299000`). The bound is
on **row count, not bytes**: 1000 thread rows each carrying a multi-MB `values` blob is still a very
large response.

**6b-bis — bound thread history. DONE** (see the shipped table). Default 100, schema cap 1000, options
read from the body, and the limit passed into `getStateHistory({ limit, before, filter })`.

Two deliberate departures from the plan above: the default is **not** derived from `SKEIN_MAX_PAGE_SIZE`
(history reads the checkpointer, not the store, so a store page bound does not apply to it), and `before`
/`metadata` are now _honoured_ rather than ignored — bounding the endpoint without them would make older
history unreachable, so paging had to start working. `before.configurable` is enumerated down to
`checkpoint_id` the way `checkpointSchema` is, so a client `thread_id` cannot ride along; forwarding it
verbatim was safe only because today's savers ignore it.

Worth knowing: `useStream` sends `limit: 10`, which was previously dropped, so it used to receive the
whole history and now receives 10 checkpoints — parity with LangGraph Platform. The transcript is
unaffected; the branch/edit tree over older turns is what shrinks.

For reference, the state before the fix: `packages/agent-protocol/src/create-handlers.ts:287-291` passes `options: undefined` when no
`limit` query param is given, and `thread-service.ts:141-149` then drains `graph.getStateHistory()` to
exhaustion, pushing **every checkpoint's full `values`** into one array, which is then
`serializeWireJson`'d into one response string. A 200-turn thread materializes its entire state history
plus that string at once. `positiveIntQuery` has no cap either, so `?limit=1000000` is accepted.
Unauthenticated by default.

Two details found while reviewing 6b, both of which make today's limit ineffective even when a client
sends one:

- The handler reads `limit` from **`req.query`**, but the route is a `POST` (`http/routes.ts:68`) and the
  LangGraph SDK sends `limit` in the **JSON body** — so for a real client the limit is silently dropped.
- Even when honoured, the limit is applied by breaking out of the `for await`. `PostgresSaver.list`
  only emits a SQL `LIMIT` when `options.limit` is set, and otherwise runs **one query that materializes
  every checkpoint row plus its `channel_values` before yielding the first one**. So the limit has to go
  into `getStateHistory({ limit })` to have any effect on memory at all.

Default the limit to **100** (smaller than the search cap — each element is a full graph state, not a
row), clamp to `SKEIN_MAX_PAGE_SIZE`, and pass it into `graph.getStateHistory({ limit })` rather than
draining and breaking, so the checkpointer stops fetching too.

**6c — push the auth ownership filter into SQL. DONE** (see the shipped table). `ThreadSearchQuery`
gained `enforcedMetadata`, a second metadata subset AND-ed with `metadata`; both drivers apply it with the
same containment semantics, and an `EXPLAIN` integration test pins that Postgres reaches
`threads_metadata_idx` for it. The `collectPages` drain in the auth-scoped store is gone — `limit`/`offset`
now page owned rows directly — and the `delete_threads` cascade pushes the same filter down (it still
drains, because it must read every row it is about to delete).

Four things worth keeping:

- **Two subsets, not one merged object.** A merge silently drops one side on a key collision: a caller
  filtering `owner: "bob"` under an ownership filter of `owner: "alice"` must match _nothing_, not one or
  the other. Also, `threadSearchSchema` is `.passthrough()`, so a request body can carry
  `enforcedMetadata` this far — the decorator _strips_ it before applying the server's own, so that holds
  even when the ownership filter translates to nothing. A test pins it.
- **The translation must never be narrower than `isAuthMatching`.** Too broad costs a few extra rows the
  in-process filter then drops; too strict silently hides rows a caller owns, and nothing downstream can
  notice. So `authFiltersToMetadataSubset` skips what it cannot express exactly — notably `{ $eq: "" }` and
  `{}`, which the engine treats as _no constraint_ because it tests the operand for truthiness. This is
  checked as a property over a (metadata × filters) matrix rather than by asserting shapes, and the
  in-process `matchesFilters` pass stays as the actual enforcement.
- **An off-type `undefined` filter value diverged between the drivers in opposite directions** — the
  memory driver matched _nothing_ (`isMetadataSubset` needs the key present-and-undefined) while Postgres
  matched _everything_ (`JSON.stringify` drops the key, leaving `metadata @> '{}'`). Reachable from an
  ordinary auth handler: `{ owner: user.metadata?.org }` for a user with no org. Skipped now. The lesson
  for the next translation of this kind: put the runtime-invalid values in the matrix, not just the
  well-typed ones — that is the class user code actually produces.
- **`$contains` wraps in an array** (`{ tags: ["red"] }`): jsonb array containment requires the stored
  value to _be_ an array holding every wanted element, which is exactly `$contains`. An unwrapped
  `{ tags: "red" }` would instead match a plain string and miss the array it was meant to find.
- The scoped `list` routes through `search` now. It takes no filter of its own, so filtering its page
  afterwards hid every row past the page bound — the same bug class as the search path.

Verified by neutering the driver clause: the conformance and paging cases fail, and **no leak test does**
— the in-process filter still holds the line.

### P7 — `statement_timeout` on by default

**DONE** (see the shipped table). `PG_STATEMENT_TIMEOUT_MS` defaults to 30000; `0` disables. Safe to turn
on now that P5's indexes and P6's bounds have landed — before them it would have converted
slow-but-working queries into errors.

The trap, which the new integration test found rather than review: **a lifted timeout leaks through the
pool.** `SET statement_timeout = 0` is session-level, so the connection that ran migrations came back to
the pool still exempt, and every later query that happened to reuse it was silently uncapped for the
life of the process. Both DDL sites now destroy their connection (`client.release(true)`) instead of
returning it, so the pool opens a fresh one and the connect hook re-applies the configured timeout.

The other DDL path is `PostgresSaver.setup()`, which takes its client from whatever pool it is given —
there is no way to lift the timeout for it from outside. It runs on a separate untimed pool that is
closed immediately afterwards, and the tuned pool is used for queries. Getting this wrong is a boot
_loop_ on an existing database (cancelled DDL → failed boot → retry → cancelled DDL), which is why the
integration test boots the whole driver stack at `statementTimeoutMs: 1`.

Per _statement_, not per request — a long sequence of quick queries is unaffected. Still-slow shapes that
will now error rather than crawl: a deep `OFFSET`, an unindexed `values @>` filter, `SELECT DISTINCT
namespace` behind `POST /store/namespaces`, text store-search with no `store.index`, and anything walking
a whole large checkpoint history (`PostgresSaver.list()` is one unbounded query).

Two of those needed more than documenting:

- **The TTL sweep would have wedged permanently.** One unbounded `DELETE` is all-or-nothing: past the
  timeout it is cancelled and rolled back, so the next hourly sweep faces a _larger_ backlog and can
  never succeed. The only symptom is a table growing forever, because reads filter expired rows out
  anyway. It now deletes in batches of 5000, each independently committed, so progress is guaranteed.
- **`multitask_strategy: "rollback"` reads a thread's whole checkpoint history unbounded**
  (`checkpoint-history.ts` `listCheckpoints`), and `run-execution.ts` catches a failure into a
  `logger.warn` — so on a very large thread the rollback now silently does not happen and the run
  proceeds on state that should have been reverted. The read happens _before_ the delete, so nothing is
  destroyed; the pre-existing wipe window (a failure between `deleteThread` and `replayCheckpoints`) is
  unchanged, since those are many small statements. **Follow-up:** bound that read, or make the failure
  loud instead of a warning.

### P8 — bundle & boot footprint

**DONE** (see the shipped table), and the honest summary is: **the correctness goal was met, the
performance goal was not there to be met.**

`docs/bundling.md` promised that embedding skein does not pull in `@langchain/langgraph-api`. That was
false. Measured, by tracing every module an `import("@skein-js/express")` resolves:

|                                   | before      | after       |
| --------------------------------- | ----------- | ----------- |
| modules loaded                    | 1436        | 1433        |
| RSS                               | ~128 MB     | ~130 MB     |
| import time                       | ~270–400 ms | ~270–400 ms |
| `@langchain/langgraph-api` loaded | **yes**     | no          |

So the leak was real and is gone, but it was never the expensive part. The graph is
`@langchain/core` (775 modules) + `@langchain/langgraph` (307) + `zod` (174) + `langsmith` (88) — 94% of
it — reached through `@skein-js/agent-protocol`, which genuinely needs the run engine. The two lazy
modules cost about **6 ms and 5.5 MB** between them; the TypeScript toolchain everyone assumes is behind
`@langchain/langgraph-api` turns out to be lazy _inside_ it already. **Do not expect P8 to move boot time
or RSS**, and do not let the plan's framing suggest otherwise to whoever reads this next.

What actually changed, all of it about what a host application is made to load rather than about speed:

- `@skein-js/config/errors` — a second entry point, so importing `SkeinConfigError` does not drag the
  `langgraph.json` loader. Internal code uses the subpath.
- `@skein-js/server-kit/dev` — `readLanggraphDevState` / `loadSnapshotIntoStore` / `describeSnapshot`
  moved off the root barrel, taking `superjson` and `node:fs/promises` with them. **No re-export** from
  the root or from `@skein-js/express`: a re-export is a static import, which would undo the split. This
  is the one breaking export move.
- `@langchain/langgraph-api/schema` and `/auth` are `await import()`ed at their single call sites — the
  points that analyse a graph schema and adapt a user's `Auth` instance. A server with baked schemas and
  no `auth` block never loads either.
- `./in-memory-runtime.js` is dynamically imported on the `{ config }` branch of `resolveRuntimeDeps`.
  This one helps a **tree-shaking bundler** and not much else: `loadInMemoryRuntime` is still statically
  re-exported from server-kit's root barrel, so under plain Node a `{ deps }` mount does still load that
  module (measured: 3 modules from `@skein-js/config`, 1 from `storage-memory`). Removing the barrel
  export would fix it and is a second breaking move — deliberately not taken for a handful of modules.

**The guard is the deliverable.** `packages/test-support/src/static-imports.test.ts` walks each adapter's
built output _transitively_, following `@skein-js/*` edges into their own `dist`, and fails if any of the
forbidden packages is statically reachable. Transitive because the original leak was invisible per
package: no adapter imported `@langchain/langgraph-api`; every adapter imported `@skein-js/server-kit`;
server-kit imported the `@skein-js/config` barrel for one error class; that barrel imported
`@langchain/langgraph-api`. A direct-imports check would have passed throughout. Verified by reverting
the lazy schema import: all four adapters fail.

Note the Nx wiring — the guard reads other packages' `dist`, so `packages/test-support/project.json`
gives its `test` target an explicit `dependsOn` on the four adapter builds. That is what makes it both
ordered _and_ cache-correct: an input glob over `packages/*/dist/*.js` looks like the right answer but
does nothing, because `dist/` is gitignored and Nx resolves `workspaceRoot` globs against the git file
map. Task-hash propagation through `dependsOn` is what actually invalidates the cache. (An explicit
`dependsOn` also _replaces_ `targetDefaults`, so `^build` has to be listed again by hand.)

### P9 — CLI & container

**DONE** (see the shipped table).

- **`skein start` refuses the in-memory drivers.** Its `--store`/`--queue` default to `postgres`/`redis`
  and reject `memory` at parse time, via its own parsers (`driver-flags.ts`) separate from `dev`'s. The
  flags are kept, not removed: images built by older `skein build` versions pass them in their CMD.
- Base image fallback moved off EOL Node 20 and now tracks Node 24 LTS. Every shipped example was
  bumped with it — they each pin `node_version` explicitly, so changing the fallback alone would
  leave them emitting an older image.
- `HEALTHCHECK --interval` 30s → 60s. The probe spawns a whole Node process (~40MB transient), which is
  real money in a 512Mi box and wasted entirely on Cloud Run / k8s / ECS, which ignore it.
- Boot warnings for the two sizing mistakes that are already true before any traffic: V8's heap ceiling
  against the cgroup limit, and run concurrency against `PG_POOL_MAX`.
- `json: { limit }` on the Express router (and the invoke router), and `requestLog` decoupled from
  `logger` — `start` needs a logger to report failed runs but not two lines per request.

**The heap warning's premise had to be rewritten after review measured it.** The standard telling —
"V8 sizes from the host, so a small container gets a multi-gigabyte heap" — is **false** for any runtime
skein ships on: Node has been cgroup-aware since v12. Measured on `node:22-slim`, `heap_size_limit` is
about half the cgroup limit (512Mi → 259MB, 1Gi → 524MB, 2Gi → 1048MB). What is real is a **floor** at
~259MB, so below roughly 345Mi the ceiling meets or exceeds the whole container — 256Mi → 101%,
128Mi → 202%. The check is worth having for that band and silent above it. Two consequences worth
remembering:

- The suggested `--max-old-space-size` must sit **below** the warning threshold, because `heap_size_limit`
  runs a few MB above whatever the flag is set to. Suggesting the threshold exactly meant the operator
  followed the advice, redeployed, and got the identical warning.
- Advice must include `--enable-source-maps`. The image bakes it into `NODE_OPTIONS`, and a platform env
  var **replaces** rather than appends — so advice naming only the heap flag silently costs TypeScript
  stack traces.

### P9b — runtime heap-pressure detection

**DONE** (see the shipped table). Samples `v8.getHeapStatistics()` on an unref'd 30s interval, warns once
per crossing at 85% and re-arms 15 points below, started by `resolveProtocolRuntime` and stopped with the
worker. `SKEIN_HEAP_WARN_PERCENT` (`0` off) / `SKEIN_HEAP_SAMPLE_MS`. `RunWorker` gained
`inFlightRunCount` so the warning can say _why_ the heap is full.

Three things worth keeping:

- **The re-arm band has to be derived from the threshold, not fixed.** A hardcoded 70% floor with
  `SKEIN_HEAP_WARN_PERCENT=60` re-arms on the very samples that trip the warning — a flat, healthy 65%
  then logs one line every other sample, forever, which is precisely the flood the latch exists to
  prevent. Reproduced before fixing.
- **Resolve every env knob before starting anything.** The options were resolved after
  `worker.start()`, so a typo'd `SKEIN_HEAP_WARN_PERCENT` threw with a live queue consumer already
  running: `skein start` tore the drivers down underneath it, and Next.js — which evicts a rejected
  runtime so the next request retries — started another worker on _every request_.
- **The band must be wider than the GC sawtooth.** Measured in `node:22-slim`: a busy process swings
  12–15 points between collections. At 85/70 a healthy-but-loaded instance warns zero times and a
  genuinely loaded one warns once. The residual risk is under-reporting (a process parked at 80–92%
  never re-arms), not noise.

Scope limit, stated in the docs rather than implied: it watches the **JS heap only**, so an RSS-driven
kernel OOM (large Buffers, many sockets) never trips it.

### P10 — run timeout & webhook

**DONE** (see the shipped table).

- **Webhook delivery hoisted out of the thread execution lock.** It was awaited in the engine's
  `finally`, which runs _inside_ `executionLocks.run(threadId, …)` — so a target taking 30s to answer
  made every other run on that thread wait 30s, and held the payload (the run's whole final state) alive
  for the duration. The engine now hands the delivery to `startRunExecution` via `deferWebhook`.
- `AbortSignal.timeout` on the default dispatcher, `SKEIN_WEBHOOK_TIMEOUT_MS`.
- `runTimeoutMs` finally reachable: `resolveRunTimeoutMs` + `--run-timeout` on both commands. Opt-in with
  no default, because a legitimate agent run takes minutes and a default would turn slow-but-working
  into killed.
- A failed `rollback` revert logs at `error`, not `warn` — the run continues on state that should have
  been reverted (P7's follow-up).

Two things review caught, both reproduced:

- **The hoist dropped the webhook whenever the run's own failure handling threw.** The engine hands the
  delivery over from _its_ `finally`, which runs on the failure path too — so a delivery awaited after
  the lock (on the success path) was silently skipped when a store write in the `catch` rejected. The
  client saw a terminal `error` run and the receiver watching for failures never heard about it: exactly
  the case webhooks exist for. Delivery now happens in `startRunExecution`'s own `finally`.
- **The timeout has to be sized against the shutdown budget, not picked round.** 10s outlived the CLI's
  force-exit deadline (`DEFAULT_SHUTDOWN_GRACE_MS` 5s + a 3s buffer = 8s), so the process would be
  killed mid-POST rather than abandoning it cleanly — and the code comment and the docs both claimed the
  opposite. Now 5s, with the arithmetic written down.

Two consequences worth knowing, both documented: webhooks for two runs on the same thread are no longer
guaranteed to arrive in run order (a slow one no longer blocks the next), and the run row is terminal
before the POST is sent — which was already true, but the hoist makes it easier to notice.

**Not done, and worth its own change:** a client-supplied `webhook` URL reaches the log lines raw, and
`z.string().url()` accepts embedded control characters (`new URL` strips them from the parsed form but
not from the original string), so an authenticated caller can forge lines in the server log. Pre-existing
— this phase only added a third interpolation site. The fix is to log `new URL(url).href` at the
boundary.

### P11 — docs

**DONE** (see the shipped table). `docs/performance.md`: what actually uses memory (in the order it
matters), worked sizing for both deployment shapes, **every knob in one table** with default/small/large,
backpressure + drop + `Last-Event-ID` recovery semantics, query bounds, a symptom→knob triage table, and
how to run the benchmark. Registered in `docs/index.md`, `llms.txt`, the README list, and
`scripts/generate-llms-full.mjs`.

Every default in the knob table was checked against the source constants by script rather than from
memory — worth repeating whenever that table is edited, since it is the one page a reader will trust
without verifying. Review then caught four claims the script could not: that the environment is
validated even when an option is passed (untrue of the heap knobs until the code was fixed to match its
own docstring, and still untrue of the two that deliberately fall back), that every knob has a code
path (four are environment-only), that _every_ list/search is bounded (`assistants.count` and
`runs.listByThread` are deliberately not), and — the one that would have sent someone the wrong way —
that `Last-Event-ID` recovers an ended stream on both buses.

**That last one is worth remembering.** On Redis the mailbox overflows while the frames survive in the
durable stream, so replay works. On the in-memory bus the stream ends _because_ the frames were evicted,
and that buffer is also the replay log — so a reconnect resumes with a hole, and
`SKEIN_STREAM_BUFFER_FRAMES` (Redis-only) does nothing about it. Both `performance.md` and
`streaming.md` had promised recovery on both.

Two stale claims the pass turned up, both of which had become false as the bounds landed:

- `docs/streaming.md` still said "**Frames are not dropped.** Backpressure delays delivery; it never
  discards." True of backpressure itself, but backpressure moves the queue into the bus — and the bus is
  bounded, so a subscriber past `SKEIN_STREAM_BUFFER_FRAMES` / `SKEIN_MEMORY_BUS_MAX_FRAMES_PER_RUN` has
  its stream _ended_. Now says so, and points at the recovery path.
- `docs/deploy.md` had grown a second copy of the tuning numbers, and it had already drifted — its
  webhook-timeout row still said 10000 after P10 changed the default to 5000. Its env section now lists
  only the required + container-specific variables and hands the tuning table off. Duplicating a knob
  table is how a doc set ends up disagreeing with itself; the fix is one table, not two kept in sync.

`docs/testing.md` gained the assertion patterns this workstream established — assert the mechanism, never
`process.memoryUsage()` — plus the two habits that actually caught bugs here: run the negative check, and
measure before writing the rationale.

### P12 — replaced by the three-runtime production program

P12 is no longer a compatibility spike. Node, Bun, and Deno are explicit production targets, with
Node remaining the fallback until each alternative passes its own production-artifact conformance
matrix.

Implemented foundations:

- `@skein-js/fetch`: native WHATWG Request/Response transport with pull-driven SSE, cancellation,
  bounded buffering, and direct `Bun.serve` / `Deno.serve` launchers.
- `skein.runtime.{name,version}` and `--runtime` / `--runtime-version`, with CLI → config → default
  precedence and legacy `node_version` support.
- runtime-specific production Dockerfiles, pinned defaults, native health checks, non-root users,
  explicit Deno permissions, PID-1 commands, and a selected-runtime graph compatibility probe.
- an injected runtime-capability boundary for environment, clocks, memory, signals, and exit.
- `/invoke` lifecycle telemetry, active OTel run context, queue/frame metrics, safe partial
  initialization, and flush-then-shutdown cleanup even when flushing fails.
- `docs/profiling.md`, including a reproducible cross-runtime performance contract and exercises.

#### First measurements (2026-07-31)

The foundations above had **no numbers attached**, which is the one habit this workstream's notes say
never to skip. These are the first. They are also what found the two defects below — neither was
visible in review, and one made every run fail.

**Rig.** Deterministic model-free graph (500 frames × 4 KB at 500 fps, the same shape
`packages/bench` uses), one `.skein/build` artifact shared by all three runtimes, `skein start` from
this tree, one Postgres 17 + Redis 7 container pair, `SKEIN_RUN_CONCURRENCY=10` everywhere. Load is
generated from a **separate process** (`.profiles/runtime-matrix/`), slow clients over a **raw paused
socket** — `packages/bench` drives a server it starts in its own process, so it cannot measure another
runtime, and a throttled `fetch` reader moves the backlog client-side. A fresh server per scenario,
because RSS never returns: reusing one folds the previous scenario's retention into the next
baseline. Server RSS from `ps` against the server PID.

| scenario   | metric               |        Node |         Bun |        Deno |
| ---------- | -------------------- | ----------: | ----------: | ----------: |
| boot       | to `GET /ok` (ms)    |         657 |         536 |         414 |
| idle       | RSS (MB)             |         181 |         113 |         129 |
| fast × 50  | frames/s             |       6,934 |       6,709 |       6,800 |
| fast × 50  | p99 first frame (ms) |         231 |         196 |         175 |
| fast × 50  | peak RSS (MB)        |         407 |         323 |         360 |
| slow × 1   | peak RSS (MB)        |         193 |         130 |         164 |
| slow × 100 | peak RSS (MB)        |         493 |         490 |         481 |
| slow × 100 | RSS after load (MB)  |         177 |         500 |         480 |
| SIGTERM    | exit (ms)            |       5,168 |       5,134 |       5,194 |
| SIGTERM    | in-flight run ends   | `cancelled` | `cancelled` | `cancelled` |

What the numbers say, and only that:

- **Throughput is a wash.** Within 3% across all three, so the transport choice — Express versus native
  Fetch — is not where time goes on this workload. Bun and Deno boot 120–240 ms faster and start
  streaming 35–55 ms sooner at p99, on a **single-instance, warm, localhost** measurement.
- **The operationally interesting number is the last RSS row, not the peak.** Peaks are within 2% of
  each other. But after the load drains, Node returns memory (493 → 177 MB) while Bun and Deno hold
  what they took (490 → 500, 481 → 480). On a 512Mi box that is the difference between headroom for the
  next burst and an OOM kill, and it is the opposite of what the lower idle RSS suggests. Anyone sizing
  a Bun or Deno deployment from the idle figure will undersize it.
- **This does not re-verify P1's plateau.** An external harness cannot separate a socket buffer from
  live run state, and 100 concurrent slow streams means 100 concurrent graph executions. RSS over idle
  works out to ~3 MB per stream against a 2 MB payload — consistent with bounded per-stream cost, and
  nothing like the 5× amplification the pre-P1 numbers showed — but the in-process assertions in
  `packages/bench` remain the actual guard.
- **SIGTERM is correct on all three.** ~5.15 s (the 5 s grace plus abort) and the in-flight run lands
  `cancelled`, read from Postgres after the process is gone. No stranded `running` row on any runtime.

**Honest limits:** single run per cell, not the five repetitions plus confidence interval
`docs/profiling.md` prescribes; host processes, not containers, so no pinned CPU/memory; macOS, not the
Linux the images run on; one deterministic workload. Directional, not publishable. The container matrix
is still required, and it is where the two defects below would have surfaced far later.

#### Three defects the measurement found

- **`skein build` was broken for any project inside a monorepo.** Version pinning resolved every
  dependency from `searchForWorkspaceRoot(configDir)`. A pnpm workspace root hoists nothing, so the
  app's own dependencies are invisible there and the build threw
  `could not resolve an installed version of "@langchain/langgraph"` — for **every example in this
  repo**. It survived because the fixture in `bundle-project.test.ts` lives under `packages/cli`, whose
  own `node_modules` carries the dep, so the walk-up happened to succeed. Externals now resolve from
  the project; `SKEIN_RUNTIME_PEERS` resolve from the CLI's own tree first, because under pnpm's strict
  layout a peer of `skein-js` is not reachable from the project at all. The regression test pins a
  dependency installed _only_ next to the app — verified by reverting the fix.
- **The generated Deno image would have failed every single run.** Deno's read permission is scoped to
  `/app`, and a denial is a _throw_, not a miss: `langsmith` (reached through `@langchain/core`, so
  present in every graph) reads `~/.langsmith/config.json` while constructing its client, so every run
  ended with `NotCapable: Requires read access to "/root/.langsmith/config.json"`. In the matrix this
  looked exactly like a broken transport — Deno delivered **1 frame per stream where Node and Bun
  delivered 501** — which is why "the Fetch adapter works on Deno" could not have been concluded from
  the code. `ENV HOME=/app` puts the probe inside the granted scope. Two things checked while fixing
  it: the image's `HOME` is `/root` even under `USER deno` (so widening the read scope to the real home
  would not have helped), and `deno install` materialises packages into `/app/node_modules/.deno/`
  rather than symlinking into `DENO_DIR`, so `--allow-read=/app` is genuinely sufficient for module
  loading. **The lesson for the rest of this program: a sandboxed runtime turns a dependency's
  optional file probe into a hard failure, and the failure surfaces as data loss, not as a permission
  error at boot.**

- **The generated Deno image could never have been built.** `deno eval` — used by both the build-time
  graph compatibility probe and the `HEALTHCHECK` — has **implicit access to every permission and
  rejects `--allow-*` outright** (`error: unexpected argument '--allow-read' found`). So the probe
  failed the image build, and had it not, the health command would have exited non-zero forever and
  pinned the container permanently unhealthy. `deno run` is the exact opposite: it needs every grant
  spelled out. Found by actually building the image, which nothing did until now.

Also confirmed while measuring: the LangGraph CLI (1.4.3+js) accepts both `node_version: "24"` and an
unknown top-level `skein` key, so the `skein.runtime` block does not break the drop-in promise.

#### The graduation matrix is now CI, not a manual ritual

The correctness half is automated, because runner co-tenancy moves timings but not pass/fail:

- **`runtime-matrix`** (`.github/workflows/ci.yml`) runs
  `packages/test-support/scripts/runtime-conformance.mjs` for node, bun, and deno against Postgres and
  Redis services. Fourteen checks driven by the **real `@langchain/langgraph-sdk`** — assistants,
  streaming, `runs.list` limit/offset, store, history, cross-instance join through Redis, burst
  retention, and SIGTERM leaving no run stranded as `running`. Verified to catch the Deno `HOME` defect
  by reverting the fix.
- **`runtime-images`** builds the real production image per runtime from the local packages and runs it
  under `--memory=512m`. Node and Bun get the full run pass (boot, no error frame, SIGTERM, terminal
  status); Deno is **build-only**, because `deno install` will not recurse into a vendored package's own
  `file:` dependencies. That is a property of substituting _unpublished_ packages — a released
  `skein-js` installs from the registry — so drop `--build-only` once a prerelease exists.
- Both jobs, and the two existing ones, now run on **Node 24 LTS**. They were on Node 20, which the
  codebase's own comments call EOL, while `skein build` shipped images on 24. Testing a different major
  than you ship is how three image defects survived a full phase of review.

Worth keeping from writing the image harness: **no single local-package form works across the three
installers.** Tarballs are what npm and bun want (devDependencies dropped, root `overrides` reach
inside); `deno install` symlinks `node_modules/<pkg>` straight at the `.tgz` and dies with
`Not a directory`. Extracted directories are what Deno needs, but npm then treats them as links,
installs their devDependencies even under `--omit=dev`, and refuses to apply `overrides` to them. The
script picks per runtime and says why.

Graduation work still required before Bun or Deno is labelled fully supported: the **performance** half,
on a machine whose CPU nobody else is using (see the environment options in `docs/profiling.md`) —
slow/disconnected SSE clients under pinned CPU and memory, AsyncLocalStorage parentage, and the raw
results published. The benchmark claim remains deliberately measurable: full protocol correctness plus a
reproducible win in p99, memory, throughput, cold start, or operating cost without a material regression
elsewhere. On the numbers above there is **no such win yet** — throughput is a wash and Node reclaims
memory better — so the honest status stays "⚠️ preview".

One blocker to know about before attempting the image matrix: the artifact pins `skein-js` to the
**published** version, so an image built from this tree installs 0.11.3 from npm and its CMD passes
`--runtime`, which that version does not understand. Measuring the real images needs local tarballs
plus npm `overrides` for every `@skein-js/*` package, or a prerelease publish.

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
- **P6** — **every list/search truncates at 1000** (`SKEIN_MAX_PAGE_SIZE`), including one with no
  `limit`, where it previously returned every row; a `limit` above 1000 is now a 400. `/history` will
  default to 100 in 6b-bis. The one most likely to surprise someone — and truncation is not signalled on
  the response, so say so: page by what you received, not by what you asked for.
- **P7** — `PG_STATEMENT_TIMEOUT_MS` defaults to 30s, so a query that used to crawl now errors with
  `57014`. `0` restores the old behaviour.
- **P8** — `readLanggraphDevState` / `loadSnapshotIntoStore` / `describeSnapshot` move from
  `@skein-js/server-kit` (and `@skein-js/express`) to `@skein-js/server-kit/dev`. No deprecation alias:
  a re-export would defeat the split. `SkeinConfigError` gains a `@skein-js/config/errors` subpath; the
  root export stays.
- **P9** — **`skein start` refuses `--store memory` / `--queue memory`** and defaults to
  postgres/redis. Node 24 LTS base image. Request logging off by default under
  `start` (`--request-log` / `SKEIN_REQUEST_LOG` to restore). HEALTHCHECK every 60s, not 30s.
- **P10** — slow webhook targets now fail instead of hanging a thread lock.
