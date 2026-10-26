# @skein-js/storage-sqlite

Durable Agent Protocol resources and a run queue in one SQLite file. Requires Node 22, 24 or 26 and
`better-sqlite3`; no database service is needed.

📖 **Docs:** [Local SQLite storage](https://skein-js.github.io/skein-js/storage#local-sqlite-storage) · [Local deployment](https://skein-js.github.io/skein-js/local-deployment)

```ts
import { openSqliteStorage } from "@skein-js/storage-sqlite";

const storage = await openSqliteStorage({ filename: "/absolute/path/state.sqlite" });
const thread = await storage.store.threads.create();
// Stop consumers before disposal.
await storage.dispose();
```

`SqliteStorageOptions` accepts `filename`, `maxPageSize`, `ttl` (item retention), and `threadTtl`.
The result provides the existing `SkeinStore` and `RunQueue` contracts, a borrowed `better-sqlite3`
`database`, and idempotent `dispose()`.

One process owns the file until disposal. Opening a second owner fails after the internal five-second
lock timeout. The connection uses WAL, full synchronous commits and foreign keys. Its initialization
write acquires exclusive ownership before startup reconciliation. Do not close or change locking
settings on the borrowed connection. Skein's tables and migration ledger use the `skein_` prefix.

Background intent is recorded by the protocol engine. Run creation and job admission then commit
atomically, including guarded creation and cron claims. Duplicate enqueue preserves the original due
time. The queue defaults to concurrency one; the existing protocol worker controls its own concurrency.

On reopening, abandoned executing/claimed attempts and pending inline requests become `error` with
`ProcessLostError`. Unclaimed queued work retains its due time. Terminal results, saved values,
interrupts and checkpoints are preserved. Skein does not replay failed input or automatically resume
checkpoints. Applications decide their next action through existing APIs. Delivery outbox leases
remain eligible for the existing retry worker.

This driver provides memory-style text/filter search. It does not provide semantic/vector indexing,
a distributed worker queue, or browser/Bun/Deno support. It does not construct LangGraph checkpoints;
use [@skein-js/local](../local/README.md) for the supported shared-connection assembly.

## Thread dispatch

The queue implements the optional `RunQueue.consumePartitioned` capability used by the run worker.
Busy thread heads remain pending while independent threads use free execution slots. Returning `false`
from the callback defers without acknowledging or spending a failure attempt; `true` acknowledges.
Original delay floors, deduplication and existing driver failure/recovery behavior still apply.

Retention readback is included on ordinary resource projections: threads optionally report `ttl`
(minutes), `expires_at`, and `ttl_strategy`; store items/search results report `ttl` and `expiresAt`
(`expires_at` over HTTP). `null` means known no expiry; absent metadata means unavailable. Reads
that refresh TTL return the updated expiry. Passive inspection can request `refreshTtl: false`.
Thread expiry marks eligibility for sweeping, which may be deferred while work is active.
