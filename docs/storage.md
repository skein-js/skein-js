# Storage

**What this gives you:** durable agents and **long-term memory** that outlives a single
conversation, with zero setup in dev. Threads, runs, and stored memories survive restarts, and inside
a graph node you get a LangGraph-native store — `getStore()` — for cross-thread facts ("prefers window
seats") backed by **pgvector semantic search** in production. It's the same store LangGraph Platform
auto-provides, so a graph that calls `getStore()` runs unchanged on skein-js. The best part: you write
your graph once and skein-js swaps the backend for you — **in-memory in `skein dev`, Postgres +
pgvector in production** — no code change. The flagship [`chat-app`](../examples/chat-app) example uses
this to remember a user across sessions.

skein-js separates two kinds of persistence, and it is important not to conflate them:

1. **Graph checkpoints** — LangGraph's own state/history for a thread (this is what powers
   **interrupt/resume** and history). **Reused, never reimplemented:** delegated to an existing
   LangGraph checkpointer (`MemorySaver` in dev, `PostgresSaver` in prod;
   `@langchain/langgraph-checkpoint-redis` and `-sqlite` are also available). See [reuse.md](./reuse.md).
2. **Protocol resources** — assistants, thread metadata/status, run rows, and long-term
   store items. These are the gap OSS keeps _in memory_, so skein-js owns them behind a single
   `SkeinStore` interface with durable drivers.

## Contents

- [`SkeinStore` interface](#skeinstore-interface)
- [Page bound (`SKEIN_MAX_PAGE_SIZE`)](#page-bound-skein_max_page_size)
- [Server-enforced metadata](#server-enforced-metadata-enforcedmetadata)
- [Drivers](#drivers)
- [Bringing your own store](#bringing-your-own-store-storeadapter)
- [Checkpointer selection](#checkpointer-selection)
- [Why the split matters](#why-the-split-matters)

## `SkeinStore` interface

A single interface, implemented by each driver, covering the protocol resources:

```ts
interface SkeinStore {
  // assistants (derived from langgraph.json graphs, plus user-created)
  assistants: AssistantRepo;

  // threads: metadata + status (idle | busy | interrupted | error), plus the latest turn's error
  threads: ThreadRepo;

  // runs: status + queue rows (pending | running | success | error | cancelled | timeout),
  // and — for a failed run — why (see errors-and-logging.md)
  runs: RunRepo;

  // schedules that fire runs on a cadence, plus the compare-and-swap claim the scheduler uses
  crons: CronRepo;

  // long-term memory: namespace/key items with optional semantic search
  store: StoreRepo;

  // recorded responses for `Idempotency-Key`, so a provider's retry replays instead of re-running
  idempotency: IdempotencyRepo;
}
```

Each repo exposes CRUD + list/search shaped to the [Agent Protocol](./agent-protocol.md)
endpoints. All drivers are validated against **one shared conformance test suite**, so
memory and Postgres behave identically.

### Page bound (`SKEIN_MAX_PAGE_SIZE`)

Every list and search path is **bounded — including when the caller passes no `limit` at all**. The
default is **1000 rows**. This is a memory bound: a thread row carries the thread's mirrored graph
state, so an unbounded `POST /threads/search` on a large deployment materializes the table twice over
(the rows, then the JSON response string) inside one request.

| Surface                                 | Bound                                                       |
| --------------------------------------- | ----------------------------------------------------------- |
| `limit` on a search request             | rejected above 1000 by the wire schema                      |
| `limit` omitted, or a `list()` call     | the first `SKEIN_MAX_PAGE_SIZE` rows (default 1000)         |
| `assistants.count()`, `threads.count()` | **not** bounded — they answer "how many match" in total     |
| `runs.listByThread()`                   | **not** bounded — run rows carry no graph state             |
| `runs.latestForThread()`                | one row by construction — the thread state path uses this   |
| `runs.listActiveRuns()` (all threads)   | bounded — the whole-server sweep behind `POST /runs/cancel` |
| `POST /threads/{id}/history`            | 100 checkpoints by default, 1000 max — a separate bound     |

`runs.latestForThread()` exists because the unbounded `listByThread()` above used to be read on **every**
thread state, history, and state-update request: resolving which graph a thread belongs to means reading
its most recent run's `assistant_id`, and that was done by fetching the thread's entire run history and
sorting it. A driver must return the newest run by `created_at` descending, tie-broken on `run_id`
descending — the tie-break is a within-driver determinism contract (`created_at` ties at millisecond
resolution), not a cross-driver one.

Sizing guidance is in [performance.md](./performance.md#sizing). Set `SKEIN_MAX_PAGE_SIZE` to change the
driver bound (`maxPageSize` on the store constructor and on
`embedPostgresGraphs` do the same in code). Lowering it is the useful direction on a small container.
Raising it widens what an omitted `limit` returns, but **not** the wire cap: a client-supplied `limit`
is still rejected above 1000, deliberately, so a single request can't be made arbitrarily expensive
from outside.

Truncation is **not** signalled on the response today — a short page is indistinguishable from the end
of the results, so page with `offset` until you get fewer rows than you asked for. Lowering the bound
below 1000 clamps a client-supplied `limit` silently for the same reason, so page by what you _received_
rather than by what you requested.

### Server-enforced metadata (`enforcedMetadata`)

`ThreadSearchQuery` carries a second metadata subset alongside `metadata`, AND-ed with it. It is set by
the server, never read from a request body, and exists so the auth ownership filter is a `WHERE` clause
instead of a full read plus an in-process pass — see
[agent-protocol.md](./agent-protocol.md#authentication--authorization).

Two subsets rather than one merged object, because a merge would silently drop one side on a key
collision: a caller filtering `owner: "bob"` while the ownership filter requires `owner: "alice"` must
match **nothing**, not one or the other. Both drivers apply it with the same containment semantics as
`metadata`, and the shared conformance suite holds them to that.

### Assistant versioning

`AssistantRepo` carries full CRUD plus a **version history** (LangGraph parity — see the
[assistants endpoints](./agent-protocol.md#assistants)). The model is deliberately simple so nothing
else has to change:

- Each assistant keeps an append-only list of immutable **version snapshots**
  (`graph_id`/`name`/`description`/`config`/`context`/`metadata` at that version).
- The **live assistant row mirrors the currently-active version** and carries its `version` number.
  So every existing reader — `get`, `list`, the run engine's graph resolution, thread history —
  keeps working unchanged; a run always resolves the assistant's _active_ version.
- `create` seeds version 1. `update` mints a new version (`max + 1`) and makes it active.
  `setLatest(version)` rolls the live row back to an existing snapshot **without** minting a new one.
  `listVersions` returns history newest-first (filterable by metadata, paginated). Deleting an
  assistant cascades its versions.

The memory driver holds versions in a second map; Postgres uses an `assistant_versions` table
(`PRIMARY KEY (assistant_id, version)`, `ON DELETE CASCADE` from `assistants`) added in migration
`0003`. Both are exercised by the shared conformance suite.

### Long-term memory in the graph (`getStore()`)

The `store` repo isn't only reachable over the `/store/items` HTTP endpoints — it is also injected
into **every graph run** as a LangGraph
[`BaseStore`](https://docs.langchain.com/oss/javascript/langgraph/persistence),
alongside the checkpointer. A node reads and writes cross-thread memory the LangGraph-native way:

```ts
import { getStore } from "@langchain/langgraph";

async function remember(state) {
  const store = getStore(); // the run's SkeinStore.store, as a BaseStore
  await store.put(["memories", userId], "prefs", { units: "metric" });
  const hits = await store.search(["memories", userId], { query: "units" }); // pgvector in Postgres
  return { ... };
}
```

This is what makes skein a faithful drop-in: LangGraph Platform auto-provides a store to graphs, so
a graph that calls `getStore()` runs unchanged on skein. The bridge is `SkeinBaseStore` in
[`@skein-js/agent-protocol`](../packages/agent-protocol), attached in the run engine the same way the
checkpointer is. Semantic `search` uses pgvector on the Postgres driver and a naive scan on memory —
both come from the same `StoreRepo`, so behavior matches.

### Filtering and namespace traversal

Two ways to narrow a store read: by **content** (`search`'s `filter`) and by **namespace shape**
(`listNamespaces`' `prefix`/`suffix`/`maxDepth`). Both are honoured over HTTP and through
`getStore()`, and both are pinned for every driver by the shared conformance suite.

```ts
await store.search(["users", userId], { filter: { topic: "coffee", score: { $gte: 3 } } });
await store.listNamespaces({ prefix: ["users", "*"], suffix: ["facts"], maxDepth: 3 });
```

**`filter`** applies to the **top-level** keys of an item's `value`, never a nested JSON path — `"a.b"`
is the literal key `"a.b"`. Keys are ANDed, as are multiple operators on one key. The operators are
LangGraph's — `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin` — and a bare scalar means
equality. It is applied **before** paging, so a page is a page of matches.

| Case                            | Behaviour                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Ordering (`$gt`/`$gte`/…)       | **Numbers only** on both sides. A string, boolean, `null`, object, array or absent key never matches |
| Key absent from `value`         | `$ne` and `$nin` match; `$eq`, a bare scalar, `$in` and every ordering operator do not               |
| Present JSON `null`             | Distinguishable from absent — `{ deleted: null }` means "present and null"                           |
| Empty operator bag `{}`         | States no conditions, so it matches everything                                                       |
| Unknown `$op`, non-scalar value | **400** at the boundary, not a silent narrowing                                                      |

The ordering rule is a **deliberate departure from LangGraph**, which coerces both sides with
`Number()` — so upstream treats `"5" > 3` as true. That is not reproducible in Postgres, where
`'abc'::numeric` throws rather than yielding `NaN`, and reproducing it faithfully would also make
`true > 0`, `null >= 0` and `"" <= 5` all true. One rule both drivers implement beats two that agree
by accident; the divergence is limited to numeric strings. (LangGraph's engine is internal — no export,
no `.d.ts` — so skein reimplements it in `matchesItemFilter`, and the conformance suite pins _skein's_
behaviour. It cannot detect upstream drift.)

**Namespace matching** is positional. `"*"` stands for exactly one segment, `prefix` anchors at the
first and `suffix` at the last, and a path longer than the namespace never matches. A path _shorter_
than the namespace still matches, which is what makes `prefix` select a subtree: `["users","*"]`
matches `["users","1"]` and `["users","1","memories"]` alike. `maxDepth` truncates each match to that
many segments and de-duplicates, before sorting and paging — so `{ maxDepth: 1, limit: 10 }` is ten
_roots_, not the roots of the first ten namespaces.

Namespaces come back in ascending, element-wise order, shorter first on a shared prefix. Per-segment
ordering follows the **driver's** collation: Postgres orders `text[]` under the database collation,
the memory driver under UTF-16 code units. These agree for ordinary segments and can differ on exotic
ones (`"a-b"` vs `"ab"` under `en_US.UTF-8`). Forcing agreement is not available — `COLLATE "C"` cannot
apply to `text[]`, and flattening to a string reintroduces the separator collision the suite pins
against — so the contract is the element-wise order, not a byte-exact one.

> **Driver authors:** `StoreRepo.listNamespaces` takes a single `StoreNamespaceQuery`
> (`{ prefix, suffix, maxDepth, limit, offset }`) rather than the old `(prefix, pagination)` pair,
> which could not express a wildcard, a suffix or a depth. `listNamespaces(["users"])` becomes
> `listNamespaces({ prefix: ["users"] })`. Like every other list path, it now applies the driver's
> page bound when the caller names no `limit`.

#### Multi-tenancy is yours to define

`prefix`, `suffix` and `filter` are _request parameters_, not access control. An omitted prefix matches
every namespace and a short one matches every namespace beneath it, so a caller who can reach
`POST /store/items/search` can read every item in the store — no wildcard required.

**skein deliberately offers no store-scoping mechanism of its own.** Who owns what, and how a namespace
encodes it, is exactly the policy a deployment should hold — and it is the part that varies most between
them. So skein does what `@langchain/langgraph-api` does: fire the `@auth.on.store` event, and serve the
namespace the request (or your handler) decided on.

What that gives you is complete control, in one place. LangGraph's idiom for store authorization is that
the handler **rewrites** `value.namespace`, and skein honours that — see
[agent-protocol.md](./agent-protocol.md#authentication--authorization) for the pattern, the payload your
handler receives, and the two limits worth knowing (it covers the HTTP surface, not `getStore()` inside a
graph; and an identity containing `.` needs encoding).

### Store item TTL

Store items can expire, matching LangGraph's store TTL. Configure it in `langgraph.json` under
`store.ttl` (all durations in **minutes**):

```json
{
  "store": { "ttl": { "default_ttl": 1440, "refresh_on_read": true, "sweep_interval_minutes": 60 } }
}
```

- `default_ttl` — lifetime applied to a `put` that doesn't pass its own `ttl`. A `PUT /store/items`
  body may include a per-item `ttl` (minutes) that overrides the default for that item.
- `refresh_on_read` (default `true`) — a `get` extends a live item's expiry by its own TTL.
- `sweep_interval_minutes` (default `60`) — how often the background sweeper deletes expired rows.

Expiry is enforced two ways: **lazily** (an expired item reads as absent from `get`/`search`/
`listNamespaces` even before it's swept) and by the **sweeper** (a periodic `DELETE`). With no
`store.ttl` set, items never expire. The sweeper runs in the production runtime (`skein up`/`build`,
and `skein dev --store postgres`); pure in-memory `skein dev` still enforces expiry lazily on read.

### Thread TTL

Threads can expire too, configured under `checkpointer.ttl` — the shape LangGraph Platform documents,
so the same `langgraph.json` works under both. Durations in **minutes**:

```json
{
  "checkpointer": {
    "ttl": { "default_ttl": 43200, "strategy": "delete", "sweep_interval_minutes": 60 }
  }
}
```

- `default_ttl` — lifetime applied to a thread created without its own `ttl`. `POST /threads` accepts a
  per-thread `ttl` (minutes) that overrides it, and an explicit `null` **pins** the thread so no TTL
  ever collects it. `PATCH /threads/{id}` can change or clear it later; a new value restarts the clock.
- `strategy` — only `"delete"` is implemented, and it is the only thing a thread could expire into.
- `sweep_interval_minutes` (default `60`) — how often the sweeper runs.

**Expiry means "may be collected", not "gone"** — the one place this deliberately differs from store
items. An expired thread still reads normally from `GET /threads/{id}` and search until the sweeper
takes it. Hiding it early would make a thread with an in-flight run vanish out from under that run.

The sweeper deletes through the **thread service**, not the driver: an expiring thread's in-flight run
is aborted and its event bus closed first, then its runs and checkpoints go with it. That is why it
lives beside the cron scheduler rather than with the store-item sweeper — a thread is a container, not
a row. It collects a bounded batch per tick and re-ticks immediately while the batch stays full, so a
backlog drains without waiting out the interval.

> **Deleting a thread deletes any cron scheduled on it.** Thread crons cascade with their thread (the
> same `ON DELETE CASCADE` a manual `DELETE /threads/{id}` triggers), so a **thread-scoped**
> [cron](./crons.md) on an expiring thread stops firing — silently, since nothing errors. Either pin
> such threads with `ttl: null` or use a stateless cron, which owns no thread to lose.

The sweeper runs whether or not `checkpointer.ttl` is set, because a per-thread `ttl` can arrive on any
`POST /threads`; the config block supplies the _default lifetime_ and the cadence, not permission to
collect. With neither configured nor requested, nothing has an expiry and each sweep is one indexed
read that finds nothing.

With no `checkpointer.ttl` set, no sweeper runs and threads live until something deletes them.

> Note this goes **past** LangGraph OSS rather than catching up to it: the open-source
> `@langchain/langgraph-api` accepts `ttl` on thread create and silently drops it — thread expiry is a
> LangGraph Platform feature there.

## Drivers

### `@skein-js/storage-memory` (dev/tests — and the Redis-less production path)

- In-process maps; zero external dependencies.
- Paired with an in-memory queue and a `MemorySaver` checkpointer for `skein dev`.
- `store` semantic search falls back to a naive scan/embedding compare.
- **Not only a dev driver.** `embedPostgresGraphs` uses this queue and event bus whenever no Redis URL
  is configured, so its retention bounds apply to real traffic — see
  [embedding.md](./embedding.md#going-to-production) for `SKEIN_MEMORY_BUS_MAX_FRAMES_PER_RUN` and
  `SKEIN_MEMORY_BUS_MAX_RETAINED_RUNS`.

### `@skein-js/storage-postgres` (prod)

- Backed by `pg`; owns tables for assistants (+ assistant_versions)/threads/runs/store items +
  migrations. `store.migrate()` applies them on boot — idempotent, tracked in a `skein_migrations`
  table, and serialized by an advisory lock so concurrent boots queue rather than collide. The SQL is
  compiled into the package (no filesystem access at runtime), so the driver bundles with zero
  externals — see [bundling.md](./bundling.md).
- Uses **`@langchain/langgraph-checkpoint-postgres`** (`PostgresSaver.fromConnString`) for
  graph checkpoints — we wrap it rather than reimplement checkpointing.
  <https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-postgres>
- **pgvector** for semantic store search, configured from `langgraph.json`'s
  `store.index.{embed, dims, fields}` (see [langgraph-cli-compat.md](./langgraph-cli-compat.md)).
  pgvector is **opt-in**: the base schema needs no extension, so skein runs on a stock managed
  Postgres out of the box. Only when `store.index` is set does `migrate()` run
  `CREATE EXTENSION IF NOT EXISTS vector` and add the `embedding` column — which requires a Postgres
  that ships pgvector (see the provider table in [deploy.md](./deploy.md#1-a-postgres)).

#### Indexes, and the one thing to watch on upgrade

Migration `0005_performance_indexes` adds the indexes the list/search paths need: composite
`(created_at, thread_id)` and `(updated_at, thread_id)` on `threads` matching the `ORDER BY … , <id>`
the queries actually emit, `(status, created_at)` for the status filter, GIN `jsonb_path_ops` on
`threads.metadata` and `assistants.metadata` for the `metadata @> …` containment the auth ownership
check performs on **every** request, `runs (thread_id, created_at)`, and `store_items (created_at, key)`.
`runs_thread_id_idx` is dropped, superseded by the composite with the same leading column.

They are built with **`CREATE INDEX CONCURRENTLY`**, so the boot migration does not hold a
write-blocking lock while indexing an existing table — a plain `CREATE INDEX` on a large `threads`
would stall writes for minutes, at boot, during a rolling deploy. Concurrency has one cost: such a
migration cannot be transactional, so a failure partway leaves some indexes created and the ledger row
unwritten, and the next boot retries the whole migration. Every statement is `IF NOT EXISTS` for that
reason.

**If an index build is interrupted** (the pod is killed mid-migration, say), Postgres leaves an
_invalid_ index behind — and `IF NOT EXISTS` will then skip it forever, so queries silently never use
it. Nothing breaks; it just stays slow. To check and fix:

```sql
-- Any invalid indexes?
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE NOT i.indisvalid;

-- Drop each one; the next boot rebuilds it.
DROP INDEX CONCURRENTLY <name>;
```

#### Semantic search: exact by default, HNSW opt-in

With `store.index` configured, semantic search ranks by cosine distance over an **unindexed**
`embedding` column — an exact scan of every row. Correct, and fine until the store is large. Add
`"hnsw": true` to opt into an HNSW index:

```json
{
  "store": {
    "index": { "embed": "openai:text-embedding-3-small", "dims": 1536, "hnsw": true }
  }
}
```

Off by default deliberately: HNSW is an **approximate** nearest-neighbour index, so turning it on
changes which rows a search returns. That is a semantic change, not something to inherit from an
upgrade.

Enabling it also **pins the column to `vector(dims)`** — pgvector cannot index a dimensionless
`vector`, which is how the column is created so the base schema works without knowing `dims`. If rows
already exist at a different dimensionality (an embedder or model change), boot fails with an error
saying so rather than a raw Postgres one; re-embed or clear those rows before enabling it.

Three things to know before turning it on:

- **The first boot is not free.** Pinning the column rewrites the table under `ACCESS EXCLUSIVE`, which
  blocks reads and writes on `store_items` for the duration and queues behind any long-running query
  already touching it. The index build that follows is concurrent and does _not_ block, but it does
  hold boot until it finishes. If pgvector warns that the graph no longer fits in
  `maintenance_work_mem`, raise it — that is the biggest lever on build time.
- **Namespace-filtered search needs pgvector ≥ 0.8.** HNSW selects a fixed candidate set
  (`hnsw.ef_search`) and the namespace predicate is applied _after_ it, so a prefixed search can return
  fewer rows than exist — or none. skein sets `hnsw.iterative_scan = strict_order` on every connection
  to prevent that, which requires pgvector 0.8. On an older server it warns once at startup and the
  post-filter behaviour stands; leave `hnsw` off there.
- **Turning it back off does not unpin the column.** `hnsw: false` skips the `ALTER`, it does not
  reverse it, so a later `dims` change still fails on the pinned column. Undo it by hand:
  `ALTER TABLE store_items ALTER COLUMN embedding TYPE vector;`

An interrupted build leaves an invalid index; the next boot detects it, drops it concurrently and
rebuilds. That check exists because pinning a column whose index is invalid rebuilds that index
_inline_ and non-concurrently, holding `ACCESS EXCLUSIVE` for the whole build.

```ts
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

const checkpointer = PostgresSaver.fromConnString(process.env.POSTGRES_URI!);
await checkpointer.setup(); // idempotent migrations for checkpoint tables
```

### Bringing your own store (`store.adapter`)

Long-term memory is the one repo you can swap without implementing the other five. Point
`store.adapter` at a `"path:export"` and skein uses it for `/store/*` **and** for the `getStore()` handed
to every graph run; assistants, threads, runs, crons and idempotency keep using the configured driver.

```jsonc
{ "store": { "adapter": "./src/my-store.ts:store" } }
```

```ts
// src/my-store.ts — LangChain's own JS long-term-memory guide builds on this exact class.
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";

export const store = PostgresStore.fromConnString(process.env.POSTGRES_URI!);
await store.setup(); // top-level await: `store.adapter` imports a *ready* store
```

The export may be **either** a LangGraph
[`BaseStore`](https://docs.langchain.com/oss/javascript/langgraph/persistence) — `PostgresStore`,
`InMemoryStore`, your own — or a skein `StoreRepo`. They are told apart structurally (`BaseStore` has
`batch`), and a mis-shaped export fails at **startup** naming the missing method, rather than at the first
request that reaches it. Prefer `BaseStore`: it is the wider ecosystem, and `PostgresStore` brings pgvector
with HNSW _and_ IVFFlat plus a `"text" | "vector" | "hybrid" | "auto"` search mode — hybrid search being a
capability skein's own driver does not have.

**What the adapter does, and why it costs a little.** skein's filter operators, positional namespace
matching, ordering and page bound are **re-applied in JS** rather than handed to the adapted store. That
is not tidiness — forwarding would be wrong. `InMemoryStore`'s `search` matches namespace prefixes as a
raw _string_ (`["users"]` also matching `["users2", …]`), ignores `query` entirely without a vector index,
and coerces filter operands with `Number()` — the one rule skein deliberately rejected because Postgres
cannot reproduce it. So the adapted store is asked for a candidate set, and for its vector ranking when it
has one; skein applies the contract on top. The price is over-fetching: more source rows are read than
returned, and paging happens after re-filtering. The
[shared conformance suite](./testing.md) runs against `fromBaseStore(new InMemoryStore())` and against a
real `PostgresStore`, which is how "serves the same contract" is a fact rather than a claim.

Four things worth knowing before you switch:

|                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`put` does a read-back**           | `StoreRepo.put` returns the stored item; `BaseStore.put` returns `void`. So the adapter writes then reads, costing a round trip — and it is **racy**: a concurrent write to the same key returns the other writer's item.                                                                                                                                                                                                                                 |
| **TTL is partly expressible**        | `store.ttl.default_ttl` works — the adapter stamps it onto every write. But `refresh_on_read` cannot be expressed through `BaseStore.get`, and it **defaults to enabled**, so `store.ttl` is refused unless you set `refresh_on_read: false` and accept write-based expiry. A store with no `sweepExpiredItems()` (`InMemoryStore`) refuses `store.ttl` outright; `PostgresStore` has it. A silently ignored retention policy is worse than a boot error. |
| **A prefix-less search fans out**    | Some stores reject an empty namespace prefix (`PostgresStore` does), so `search({})` enumerates namespaces and searches each. Scores are re-sorted globally afterwards, so semantic ranking still holds — but give a prefix when you can.                                                                                                                                                                                                                 |
| **The store may have its own rules** | `PostgresStore` rejects namespace labels containing `.`, `%`, `_` or `\`, and a root label of `"langgraph"`. Items written under such a namespace by another driver are not reachable through it.                                                                                                                                                                                                                                                         |

**Your store owns its items.** skein loads _into_ an adapter but never reads back out of it, and the
asymmetry is deliberate — your store's durability is yours to configure, not skein's to shadow. So
`skein import-langgraph`, a restored `.skein/dev-state.json`, and the one-time `langgraph dev` auto-import
all replay their items through the adapter, landing where the server will read them. But the dev-state
_snapshot_ covers the driver's resources only — assistants, threads, runs, crons — so an adapted
`InMemoryStore` loses its items when `skein dev` restarts (it is in-memory and skein is not backing it up
for you), while an adapted `PostgresStore` keeps them because it always did.

**`store.index` is refused alongside an adapter.** It configures pgvector on the store the adapter
replaces, so it could only ever have no effect on search. Configure the index on your own store instead —
`PostgresStore` and `InMemoryStore` both take one in their constructor.

In code (no `langgraph.json`), the same seam is `ProtocolDeps.storeItems` — wrap a `BaseStore` with
`fromBaseStore` first. Pass it as its own field rather than composing `{ ...store, store: mine }`: the
bundled drivers expose `maxPageSize` and `durable` as class **getters** over **private** fields, so a
spread silently loses them and a prototype clone throws on read. `withStoreItems` is the supported way to
do it by hand.

## Checkpointer selection

| `langgraph.json` `checkpointer` | skein-js uses                      |
| ------------------------------- | ---------------------------------- |
| absent (dev / `skein dev`)      | `MemorySaver`                      |
| `"default"`                     | `PostgresSaver` (Postgres)         |
| `"custom"`                      | user-supplied checkpointer (later) |

You rarely wire these drivers by hand. [`@skein-js/runtime`](../packages/runtime) assembles the
`PostgresSkeinStore` + `PostgresSaver` + Redis queue/bus (and their `dispose()`) for you, two ways:
**`buildRuntime`** from a `langgraph.json` (the `skein dev`/`skein up` path), and
**`embedPostgresGraphs`** from a graph you hold in code (the durable sibling of `embedInMemoryGraphs` —
see [embedding.md](./embedding.md#going-to-production)).

## Why the split matters

Keeping protocol resources (`SkeinStore`) separate from LangGraph checkpoints means:

- We can offer an in-memory dev experience with no database.
- Postgres parity is proven by running the **same conformance suite** against both drivers.
- Checkpoint format stays 100% LangGraph-native, so thread history/history endpoints and
  interrupt/resume behave exactly as LangGraph expects.
