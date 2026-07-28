import {
  type ConformanceStoreOptions,
  runSkeinStoreConformance,
  startPostgres,
  type StartedResource,
} from "@skein-js/test-support";
import { afterAll, beforeAll } from "vitest";

import { PostgresSkeinStore } from "./postgres-skein-store.js";

// One container for the whole suite; each case gets a freshly-migrated, truncated schema so cases
// never share state. This is the step-9 definition of done: Postgres must pass every case the
// memory driver passes, proving the two drivers are interchangeable (docs/testing.md).
let pg: StartedResource;
let store: PostgresSkeinStore;
// `maxPageSize` is fixed at connect time, so the page-bound cases need their own store rather than a
// mutated one. Keyed by the value, connected on first use, against the same already-migrated schema.
const storesByPageBound = new Map<number, PostgresSkeinStore>();

beforeAll(async () => {
  pg = await startPostgres();
  store = await PostgresSkeinStore.connect(pg.url);
  await store.migrate();
});
afterAll(async () => {
  for (const bounded of storesByPageBound.values()) await bounded.close();
  await store?.close();
  await pg?.stop();
});

runSkeinStoreConformance("postgres", async (options?: ConformanceStoreOptions) => {
  // Truncate between cases: same connected store, empty tables (RESTART IDENTITY not needed — text ids).
  await store.truncateAll();
  const maxPageSize = options?.maxPageSize;
  if (maxPageSize === undefined) return store;

  const existing = storesByPageBound.get(maxPageSize);
  if (existing) return existing;
  // The schema is already migrated by the default store above, so this only opens a second pool.
  const bounded = await PostgresSkeinStore.connect(pg.url, { maxPageSize });
  storesByPageBound.set(maxPageSize, bounded);
  return bounded;
});
