# @skein-js/test-support

> Private test helpers for skein-js — **internal, not published**.

Part of **[skein-js](https://github.com/mainawycliffe/skein)**. This package is `private` and
consumed in-repo via `workspace:*` (its exports point at TypeScript source, transpiled by each
consumer's Vitest) — you don't install it.

## What it provides

- **Testcontainers boots** — `startPostgres()` (Postgres + pgvector) and `startRedis()`, each
  returning `{ url, container, stop() }`. Used by `*.integration.test.ts` suites.
- **Shared conformance suites** — the contract every driver must satisfy, so drivers are provably
  interchangeable:
  - `runSkeinStoreConformance(label, makeStore)` — the full `SkeinStore` contract: assistants,
    threads, runs (status transitions + the `hasActiveRun` concurrency guard), the store (CRUD,
    prefix/text search, namespaces), and driver-parity isolation (a returned row must not alias
    stored state).
  - `runRunQueueConformance(label, makeQueue)` — FIFO delivery of background runs.
  - `runRunEventBusConformance(label, makeBus)` — buffered replay, `afterSeq` reconnection,
    live-tail, and close-completion.

## Usage

```ts
import { runSkeinStoreConformance } from "@skein-js/test-support";

import { MemorySkeinStore } from "./memory-skein-store.js";

// Prove the driver satisfies the shared SkeinStore contract.
runSkeinStoreConformance("memory", () => new MemorySkeinStore());
```

Container-backed variant (integration tests):

```ts
import {
  runSkeinStoreConformance,
  startPostgres,
  type StartedResource,
} from "@skein-js/test-support";

let pg: StartedResource;
beforeAll(async () => {
  pg = await startPostgres();
});
afterAll(() => pg?.stop());
runSkeinStoreConformance("postgres", async () => PostgresSkeinStore.connect(pg.url));
```

Factory types: `SkeinStoreFactory`, `RunQueueFactory`, `RunEventBusFactory`. Requires Docker for the
container helpers; suites skip with a clear message when it's absent. Peer dependency: `vitest`.

See [docs/testing.md](../../docs/testing.md) for the full strategy.

## License

[Apache-2.0](../../LICENSE)
