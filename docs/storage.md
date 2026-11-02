---
title: LangGraph.js storage — SQLite, Postgres and memory
description: Choose memory for development, SQLite for local apps, or Postgres with pgvector for a server. Skein reuses LangGraph checkpointers and the getStore interface.
---

# Storage

Choose storage for the lifetime and deployment of your project. Your graph can continue using
LangGraph's `getStore()` interface when you change the backend.

| Your project                                | Choose              | What to verify                                                      |
| ------------------------------------------- | ------------------- | ------------------------------------------------------------------- |
| Development or isolated tests               | Memory              | Graph behavior; development snapshots are not production durability |
| Desktop app, CLI, daemon, or one Node owner | SQLite              | Reopen the same file and read the thread, checkpoints, and memory   |
| Shared server                               | Postgres            | Resources and checkpoints survive restart                           |
| Multiple server instances                   | Postgres plus Redis | Queueing and stream observation work across instances               |

SQLite supports text/filter search. Semantic indexing uses Postgres with pgvector or an external
store. Start with [SQLite embedding](./local-deployment.md), [Postgres deployment](./deploy.md), or
the driver reference below.

Graph checkpoints hold conversation state/history; store items hold values across conversations.
Choose the correct lifetime before adding memory: see [state and persistence](./state-and-context.md)
and [agent memory](./memory.md).

## Verify your storage

Create a test thread, run a known input, and read its state. Write an item in a test namespace. With
SQLite or Postgres, restart using the same storage configuration and read both again. For
multi-instance servers, repeat the read through another instance. An embedded memory backend loses
its state on process exit; the CLI's development snapshots are a separate convenience. Clean up the
test thread and item afterward. Follow the
[project persistence checks](./testing-your-project.md#check-state-across-turns-and-restarts) for the
expected outcomes and local crash-recovery limits.

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

<span id="bringing-your-own-store-storeadapter"></span>

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

**skein re-applies its own semantics rather than forwarding them**, because forwarding would be wrong:
`InMemoryStore`'s `search` matches namespace prefixes as a raw _string_ (so `["users"]` also matches
`["users2", …]` — a cross-tenant read the moment a prefix is derived from a principal), ignores `query`
without a vector index, and coerces filter operands with `Number()`. So the adapted store supplies a
candidate set and its vector ranking; skein applies filtering, ordering and paging on top. The price is
over-fetching; measure this cost with your dataset before switching adapters.

Four things worth knowing before you switch:

|                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`put` does a read-back**           | `StoreRepo.put` returns the stored item; `BaseStore.put` returns `void`. So the adapter writes then reads, costing a round trip — and it is **racy**: a concurrent write to the same key returns the other writer's item.                                                                                                                                                                                                                                 |
| **TTL is partly expressible**        | `store.ttl.default_ttl` works — the adapter stamps it onto every write. But `refresh_on_read` cannot be expressed through `BaseStore.get`, and it **defaults to enabled**, so `store.ttl` is refused unless you set `refresh_on_read: false` and accept write-based expiry. A store with no `sweepExpiredItems()` (`InMemoryStore`) refuses `store.ttl` outright; `PostgresStore` has it. A silently ignored retention policy is worse than a boot error. |
| **A prefix-less search fans out**    | Some stores reject an empty namespace prefix (`PostgresStore` does), so `search({})` enumerates namespaces and searches each. Scores are re-sorted globally afterwards, so semantic ranking still holds — but give a prefix when you can.                                                                                                                                                                                                                 |
| **The store may have its own rules** | `PostgresStore` rejects namespace labels containing `.`, `%`, `_` or `\`, and a root label of `"langgraph"`. Items written under such a namespace by another driver are not reachable through it.                                                                                                                                                                                                                                                         |

**Your store owns its items.** skein imports _into_ an adapter — `skein import-langgraph`, a restored
`.skein/dev-state.json`, the one-time `langgraph dev` auto-import — but never snapshots back out of it,
because writing whatever store you brought into `.skein/dev-state.json` every few seconds is not something
to do to somebody's database. So an adapted `InMemoryStore` loses its items across a `skein dev` restart
while a `PostgresStore` keeps them. `skein dev` prints this at startup rather than letting you find it by
losing items.

**`store.index` is refused alongside an adapter.** It configures pgvector on the store the adapter
replaces, so it could only ever have no effect on search. Configure the index on your own store instead —
`PostgresStore` and `InMemoryStore` both take one in their constructor.

In code (no `langgraph.json`), the same seam is `ProtocolDeps.storeItems` — wrap a `BaseStore` with
`fromBaseStore` first. Pass it as its own field rather than composing `{ ...store, store: mine }`: the
bundled drivers expose `maxPageSize` and `durable` as class **getters** over **private** fields, so a
spread silently loses them and a prototype clone throws on read. `withStoreItems` is the supported way to
do it by hand.

## Checkpointer selection

| Storage selection                | skein-js uses                                       |
| -------------------------------- | --------------------------------------------------- |
| Memory (the default `skein dev`) | `MemorySaver`                                       |
| Postgres                         | `PostgresSaver`                                     |
| SQLite store/queue pair          | `SqliteSaver` sharing the owned resource connection |

You rarely wire these drivers by hand. [`@skein-js/runtime`](https://github.com/skein-js/skein-js/tree/main/packages/runtime) assembles the
`PostgresSkeinStore` + `PostgresSaver` + Redis queue/bus (and their `dispose()`) for you, two ways:
**`buildRuntime`** from a `langgraph.json` (the `skein dev`/`skein up` path), and
**`embedPostgresGraphs`** from a graph you hold in code (the durable sibling of `embedInMemoryGraphs` —
see [embedding.md](./embedding.md#going-to-production)).

Protocol resources (`SkeinStore`) stay separate from LangGraph checkpoints, which is what allows an
in-memory dev experience with no database while the checkpoint format stays 100% LangGraph-native — so
history endpoints and interrupt/resume behave exactly as LangGraph expects.

For SQLite, use `embedSqliteGraphs` from `@skein-js/local`, or the CLI's explicit SQLite pair.
It assembles resources, the queue, and the upstream saver with one file owner. See
[local deployment](./local-deployment.md) for lifecycle and native packaging.

## Local SQLite storage

[`@skein-js/storage-sqlite`](./local-deployment.md) implements the full resource store and a persisted
run queue in one exclusively owned file. `@skein-js/local` assembles it with LangGraph's SQLite saver.
Unclaimed work persists; abandoned attempts become failures without automatic input replay.

## Per-operation indexing and retention

The bundled memory, SQLite and Postgres stores implement optional `StoreRepo.putWithOptions`:

```ts
await store.putWithOptions!(namespace, key, value, { index: ["title"], ttl: null });
await store.get(namespace, key, { refreshTtl: false });
await store.search({ prefix: namespace, query: "meeting", refreshTtl: true });
```

`index: false` stores the item without making it a text/vector search candidate. A field list limits
indexed content; `$` includes the whole value. Exact key reads still return the complete item.
An explicit nullable TTL disables the configured default for that write. Existing `put` and its
`ttl?: number` options remain source compatible. Unsupported custom stores reject requested
advanced controls. The LangGraph bridge forwards indexing, write TTL and read/search refresh
options, including batch operations. An external BaseStore must expose the corresponding controls;
Skein does not emulate persistent expiry with process-local timers.

Thread TTL retains deletion as the default. An opt-in `keep_latest` strategy prunes old history
without deleting the thread, root checkpoint, referenced child state or pending writes. The retention
window slides when state changes; the sweep skips an active run and rearms its next check after
pruning. A null TTL pins the thread. The SQLite and Postgres migrations preserve existing pins:
older rows without a recorded TTL remain pinned rather than acquiring an unexpected expiry.

Pruning and rollback use LangGraph’s public saver methods. A scratch copy is written under a random,
operation-specific ID, checked for existing checkpoints, before erasure. Fixed names such as
`<thread>::skein-rollback` and `<thread>::skein-prune` are never used as scratch IDs because they may
belong to real threads. If replay fails, the backup's actual ID is included in the error for operator
recovery; retain that copy until recovery is complete. These operations require the same
thread execution gate as state writes. They preserve namespace coordinates when copying history.

Checkpoint pruning retains current root/child namespaces, explicit checkpoint references and
pending writes. Delta channels may also require ancestor writes until a full snapshot; those
necessary ancestors remain readable after prune and copy. `keep_latest` removes expendable history,
not checkpoint data required to reconstruct current state. Exact payload accounting is available at
`GET /threads/{thread_id}/storage`; see [diagnostics](./observability.md#http-diagnostics).

### Retention readback

Bundled memory, SQLite, and Postgres drivers enrich thread resources with optional `ttl` (minutes),
`expires_at`, and `ttl_strategy`. Store `Item` and `SearchItem` resources expose optional `ttl` and
`expiresAt` in repository results; HTTP responses serialize expiry as `expires_at`. An absent field
means the driver cannot report it; `null` means known no expiry. Thread expiry means eligible for
sweeping, rather than a promise of immediate deletion. Refresh-enabled reads return the new expiry.

These fields reuse existing storage columns, require no migration, and add no required custom-driver
methods. Passive tools can use `refreshTtl: false` to inspect without extending a sliding lifetime.

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

  // schedules that fire runs on a cadence
  crons: CronRepo;

  // long-term memory: namespace/key items with optional semantic search
  store: StoreRepo;

  // recorded responses for `Idempotency-Key`, so a provider's retry replays instead of re-running
  idempotency: IdempotencyRepo;
}
```

Each repo exposes CRUD + list/search shaped to the [Agent Protocol](./agent-protocol.md)
endpoints. Memory, SQLite, and Postgres implement the same resource contract. Their queue ownership and crash
semantics differ; see [local deployment](./local-deployment.md#what-survives-a-process-ending).

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

A custom driver's `runs.latestForThread()` must return the newest run by `created_at` descending,
tie-broken on `run_id` descending. This ordering makes ties deterministic within the driver.

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
match **nothing**, not one or the other. Custom drivers must apply both subsets with the same containment semantics as `metadata`.

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

Keep migrations enabled when upgrading a persistent deployment.

### Long-term memory in the graph (`getStore()`)

Use LangGraph's `getStore()` inside a node to read and write values across threads. For example,
a support assistant can remember a customer's preferred language between conversations. Skein supplies
the store to each run; your application chooses the namespace and access rules.

Follow the [memory guide](./memory.md) for profile and collection patterns and checks that a second
thread can retrieve the saved preference. Semantic search requires a configured embedding index; SQLite supports
text and filter search.

### Filtering and namespace traversal

Two ways to narrow a store read: by **content** (`search`'s `filter`) and by **namespace shape**
(`listNamespaces`' `prefix`/`suffix`/`maxDepth`). Both are honoured over HTTP and through
`getStore()`, across the bundled storage drivers.

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

The numbers-only ordering rule is a **deliberate departure from LangGraph**, which coerces both sides
with `Number()` and so treats `"5" > 3` as true. Postgres cannot reproduce that (`'abc'::numeric`
throws), and faithful reproduction would also make `true > 0` and `null >= 0` true. The divergence is
limited to numeric strings.

**Namespace matching** is positional. `"*"` stands for exactly one segment, `prefix` anchors at the
first and `suffix` at the last, and a path longer than the namespace never matches. A path _shorter_
than the namespace still matches, which is what makes `prefix` select a subtree: `["users","*"]`
matches `["users","1"]` and `["users","1","memories"]` alike. `maxDepth` truncates each match to that
many segments and de-duplicates, before sorting and paging — so `{ maxDepth: 1, limit: 10 }` is ten
_roots_, not the roots of the first ten namespaces.

Namespaces come back in ascending, element-wise order, shorter first on a shared prefix. Per-segment
ordering follows the **driver's** collation (Postgres's database collation; UTF-16 code units in
memory), which agree for ordinary segments and can differ on exotic ones like `"a-b"` vs `"ab"`. The
contract is the element-wise order, not a byte-exact one.

> **Driver authors:** `StoreRepo.listNamespaces` accepts a `StoreNamespaceQuery`
> (`{ prefix, suffix, maxDepth, limit, offset }`). Apply the driver's page bound when `limit` is omitted.

#### Multi-tenancy is yours to define

> `prefix`, `suffix` and `filter` are _request parameters_, not access control. An omitted prefix
> matches every namespace, so **any caller who can reach `POST /store/items/search` can read every item
> in the store** — no wildcard required.

skein offers no store-scoping mechanism of its own, deliberately: who owns what, and how a namespace
encodes it, is the policy that varies most between deployments. Scope it with an `@auth.on.store`
handler that rewrites `value.namespace` — the pattern, and its two limits, are in
[agent-protocol.md](./agent-protocol.md#scoping-the-store).

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
- `strategy` — `"delete"` (default) removes the expired thread; `"keep_latest"` retains current state, referenced namespace checkpoints and necessary ancestor writes.
- `sweep_interval_minutes` (default `60`) — how often the sweeper runs.

An expired thread remains readable through `GET /threads/{id}` and search until the sweeper
collects it. With the `delete` strategy, collection stops any active run and removes the thread,
its runs, and checkpoints.

> **Deleting a thread also deletes its thread-scoped schedules.** Pin a thread with `ttl: null`
> when its [cron](./crons.md) must keep firing, or use a stateless cron.

Per-thread TTLs are collected even without a `checkpointer.ttl` configuration block. Threads without
a configured or per-thread TTL live until explicitly deleted.
