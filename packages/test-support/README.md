# @skein/test-support

> Private test helpers for Skein — **not published**.

Provides:

- **Testcontainers boots** — `startPostgres()` (Postgres + pgvector) and `startRedis()`,
  returning a connection URL and a `stop()` teardown. Used by `*.integration.test.ts` suites.
- **`runSkeinStoreConformance(label, makeStore)`** — the shared `SkeinStore` contract, run
  against every storage driver so memory and Postgres behave identically. Covers assistants,
  threads, runs (status transitions + the concurrency guard), the store (CRUD, prefix/text
  search, namespaces), and driver-parity isolation (a returned row must not alias stored state).

See [docs/testing.md](../../docs/testing.md) for the strategy and examples.

```ts
import { startPostgres, runSkeinStoreConformance } from "@skein/test-support";
```

Requires Docker for the container helpers; suites skip with a clear message when it's absent.
