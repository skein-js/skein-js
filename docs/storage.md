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

  // long-term memory: namespace/key items with optional semantic search
  store: StoreRepo;
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

| Surface                             | Bound                                                   |
| ----------------------------------- | ------------------------------------------------------- |
| `limit` on a search request         | rejected above 1000 by the wire schema                  |
| `limit` omitted, or a `list()` call | the first `SKEIN_MAX_PAGE_SIZE` rows (default 1000)     |
| `assistants.count()`                | **not** bounded — it answers "how many match" in total  |
| `runs.listByThread()`               | **not** bounded — run rows carry no graph state         |
| `POST /threads/{id}/history`        | 100 checkpoints by default, 1000 max — a separate bound |

Set `SKEIN_MAX_PAGE_SIZE` to change the driver bound (`maxPageSize` on the store constructor and on
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
into **every graph run** as a LangGraph [`BaseStore`](https://langchain-ai.github.io/langgraphjs/reference/classes/checkpoint.BaseStore.html),
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
  <https://www.npmjs.com/package/@langchain/langgraph-checkpoint-postgres>
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
