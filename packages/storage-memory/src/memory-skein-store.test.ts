import { runSkeinStoreConformance } from "@skein-js/test-support";
import { describe, expect, it } from "vitest";

import { MemorySkeinStore } from "./memory-skein-store.js";

// The whole point of the memory driver in this slice: prove it satisfies the shared SkeinStore
// contract. Postgres will run this exact suite later, making the two interchangeable.
runSkeinStoreConformance("memory", (options) => new MemorySkeinStore(options));

// TTL config (default_ttl / refresh_on_read) can't be exercised by the config-less conformance
// factory, so cover it here against the memory driver directly. The Postgres equivalents run in the
// Docker integration suite.
describe("memory store TTL config", () => {
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const tinyTtl = 40 / 60_000; // ~40ms in minutes

  it("applies default_ttl to a put with no explicit ttl", async () => {
    const store = new MemorySkeinStore({ ttl: { defaultTtl: tinyTtl } });
    await store.store.put(["ns"], "k", { v: 1 });

    await wait(120);
    expect(await store.store.get(["ns"], "k")).toBeNull();
  });

  it("refreshes expiry on read by default, and honors refresh_on_read: false", async () => {
    const refreshing = new MemorySkeinStore({ ttl: { defaultTtl: 60 } }); // 1 min, plenty of headroom
    await refreshing.store.put(["ns"], "k", { v: 1 });
    // A read keeps the item alive; it should still be present immediately after.
    expect(await refreshing.store.get(["ns"], "k")).not.toBeNull();

    const noRefresh = new MemorySkeinStore({ ttl: { defaultTtl: tinyTtl, refreshOnRead: false } });
    await noRefresh.store.put(["ns"], "k", { v: 1 });
    await noRefresh.store.get(["ns"], "k"); // must NOT extend the expiry
    await wait(120);
    expect(await noRefresh.store.get(["ns"], "k")).toBeNull();
  });
});

// A bad `maxPageSize` is silent without the guard: `#pageLimit` returns 0 or NaN, `slice` returns
// nothing, and every list and search comes back empty with no error at all.
describe("memory store page bound validation", () => {
  it("rejects a non-positive or non-integer maxPageSize at construction", () => {
    expect(() => new MemorySkeinStore({ maxPageSize: 0 })).toThrow(RangeError);
    expect(() => new MemorySkeinStore({ maxPageSize: -1 })).toThrow(/positive integer/);
    expect(() => new MemorySkeinStore({ maxPageSize: 1.5 })).toThrow(RangeError);
    expect(() => new MemorySkeinStore({ maxPageSize: Number.NaN })).toThrow(RangeError);
  });

  // `1e21` is an integer, but it stringifies as "1e+21" and overflows a Postgres bigint — so without
  // this it boots cleanly and then fails every query on the Postgres driver.
  it("rejects a maxPageSize beyond the safe integer range", () => {
    expect(() => new MemorySkeinStore({ maxPageSize: 1e21 })).toThrow(RangeError);
    expect(() => new MemorySkeinStore({ maxPageSize: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
  });
});
