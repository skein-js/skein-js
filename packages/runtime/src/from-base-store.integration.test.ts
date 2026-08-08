// The payoff for bring-your-own store, against a real database: `PostgresStore` from
// `@langchain/langgraph-checkpoint-postgres/store` — already a skein dependency, and what LangChain's own
// JS long-term-memory guide tells users to build on — serving skein's whole `/store/*` contract through
// `fromBaseStore`.
//
// The proof is the *shared* conformance suite, so this is held to exactly the same rules as the bundled
// drivers rather than to a hand-picked subset. `PostgresStore` exposes `sweepExpiredItems`, so unlike the
// `InMemoryStore` run this one declares TTL support and takes the expiry cases too.

import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { fromBaseStore, withStoreItems } from "@skein-js/agent-protocol";
import { MemorySkeinStore } from "@skein-js/storage-memory";
import {
  startPostgres,
  runSkeinStoreConformance,
  type StartedResource,
} from "@skein-js/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let pg: StartedResource;
let store: PostgresStore;

beforeAll(async () => {
  pg = await startPostgres();
  store = PostgresStore.fromConnString(pg.url);
  // The user's adapter module is responsible for this — `store.adapter` imports a *ready* store, so a
  // real deployment does `await store.setup()` at module scope (ESM top-level await) before exporting.
  await store.setup();
}, 180_000);

afterAll(async () => {
  await store?.stop?.();
  await pg?.stop();
});

// One container for the whole suite, so each case truncates rather than migrating. `listNamespaces`
// over a dirty table would see the previous case's rows, so the store is cleared between cases.
const freshStore = async (options?: { maxPageSize?: number }) => {
  for (const namespace of await store.listNamespaces({ limit: 1000 })) {
    const items = await store.search(namespace, { limit: 1000 });
    for (const item of items) await store.delete(item.namespace, item.key);
  }
  return withStoreItems(
    new MemorySkeinStore(options),
    fromBaseStore(store, options?.maxPageSize ? { maxPageSize: options.maxPageSize } : {}),
  );
};

runSkeinStoreConformance("fromBaseStore(PostgresStore)", (options) => freshStore(options), {
  expiry: true,
});

describe("fromBaseStore(PostgresStore) — the capability skein's own driver lacks", () => {
  it("honours a per-item ttl through PostgresStore's 5-argument put", async () => {
    // `BaseStore.put` declares no `ttl`; `PostgresStore.put` takes it as a 5th argument. The adapter
    // passes it only when the store declares `sweepExpiredItems`, so this is what "TTL is reachable
    // through the adapter" actually means.
    const adapted = await freshStore();
    await adapted.store.put(["ttl-ns"], "k", { v: 1 }, { ttl: 60 });

    expect((await adapted.store.get(["ttl-ns"], "k"))?.value).toEqual({ v: 1 });
    // The sweeper is the store's own, reached through `sweepExpired()`; nothing is due yet.
    expect(await adapted.store.sweepExpired()).toBe(0);
  });
});
