import { runSkeinStoreConformance, startPostgres, type StartedResource } from "@skein-js/test-support";
import { afterAll, beforeAll } from "vitest";

import { PostgresSkeinStore } from "./postgres-skein-store.js";

// One container for the whole suite; each case gets a freshly-migrated, truncated schema so cases
// never share state. This is the step-9 definition of done: Postgres must pass every case the
// memory driver passes, proving the two drivers are interchangeable (docs/testing.md).
let pg: StartedResource;
let store: PostgresSkeinStore;

beforeAll(async () => {
  pg = await startPostgres();
  store = await PostgresSkeinStore.connect(pg.url);
  await store.migrate();
});
afterAll(async () => {
  await store?.close();
  await pg?.stop();
});

runSkeinStoreConformance("postgres", async () => {
  // Truncate between cases: same connected store, empty tables (RESTART IDENTITY not needed — text ids).
  await store.truncateAll();
  return store;
});
