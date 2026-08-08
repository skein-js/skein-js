// The headline proof for bring-your-own store: the *shared* `SkeinStore` conformance suite, run against
// a store whose long-term-memory repo is a plain LangGraph `InMemoryStore` behind `fromBaseStore`.
//
// This is the test the adapter exists to pass, and it is why the adapter re-imposes skein's semantics
// instead of forwarding them. Upstream's `InMemoryStore` disagrees with skein on three things the suite
// pins — `search` matches namespace prefixes as a raw string (`["users"]` also matching `["users2", …]`),
// it ignores `query` entirely without a vector index, and it coerces filter operands with `Number()` — so
// a pass-through adapter would fail here rather than merely behave differently.
//
// It lives in `@skein-js/runtime` because that is the only package with `agent-protocol` (for the
// adapter), `storage-memory` (for the other five repos), `@langchain/langgraph` and `test-support` all in
// scope, and because the `store.adapter` loader that produces this composition lives here too.

import { InMemoryStore } from "@langchain/langgraph";
import { fromBaseStore, withStoreItems } from "@skein-js/agent-protocol";
import { MemorySkeinStore } from "@skein-js/storage-memory";
import { runSkeinStoreConformance } from "@skein-js/test-support";
import { describe, expect, it } from "vitest";

// Only the `store` repo is adapted; assistants/threads/runs/crons/idempotency stay on the memory driver,
// exactly as `resolveDeps` composes a real `store.adapter` deployment. `withStoreItems` is what carries
// the `maxPageSize`/`durable` prototype getters an object spread would drop.
runSkeinStoreConformance(
  "fromBaseStore(InMemoryStore)",
  (options) =>
    withStoreItems(
      new MemorySkeinStore(options),
      fromBaseStore(
        new InMemoryStore(),
        options?.maxPageSize ? { maxPageSize: options.maxPageSize } : {},
      ),
    ),
  // `InMemoryStore` exposes no `sweepExpiredItems`, so TTL is unreachable through it. The suite then
  // asserts the adapter *refuses* a per-item `ttl` instead of accepting and discarding one — and
  // `store.ttl` in `langgraph.json` is refused at startup against such a store for the same reason.
  { expiry: false },
);

describe("fromBaseStore composition", () => {
  it("keeps the page bound and durability flag, which an object spread would silently drop", () => {
    const adapted = withStoreItems(
      new MemorySkeinStore({ maxPageSize: 7 }),
      fromBaseStore(new InMemoryStore()),
    );

    expect(adapted.maxPageSize).toBe(7);
    expect(adapted.durable).toBe(false);
  });

  it("narrows a namespace prefix segment-wise, where the adapted store matches a raw string", async () => {
    // `InMemoryStore.search` does `namespace.join(":").startsWith(prefix.join(":"))`, so `["users"]`
    // there also matches `["users2", …]`. Once a scope prefix is derived from a principal, that is a
    // cross-tenant read — so the adapter re-applies positional matching rather than trusting the source.
    const store = fromBaseStore(new InMemoryStore());
    await store.put(["users"], "own", { v: 1 });
    await store.put(["users2", "other"], "foreign", { v: 2 });

    const found = await store.search({ prefix: ["users"] });

    expect(found.map((item) => item.key)).toEqual(["own"]);
  });

  it("returns each item once from a prefix-less search, despite overlapping source prefixes", async () => {
    // A prefix-less search asks about every namespace, and `InMemoryStore` matches a prefix as a raw
    // string — so `["memories"]` also returns items living in `["memories","alice"]`, and the *sibling*
    // `["users","1"]` also returns `["users","10"]`'s. Both would otherwise be counted twice.
    const store = fromBaseStore(new InMemoryStore());
    await store.put(["memories"], "shallow", { v: 1 });
    await store.put(["memories", "alice"], "deep", { v: 2 });
    await store.put(["users", "1"], "one", { v: 3 });
    await store.put(["users", "10"], "ten", { v: 4 });

    const found = await store.search({});

    expect(found.map((item) => item.key).sort()).toEqual(["deep", "one", "shallow", "ten"]);
  });

  it("finds a text match beyond the first page, rather than pre-truncating the candidates", async () => {
    // The text predicate has to narrow *before* paging. Filtering a page that was already cut to
    // `limit` pre-filter candidates returned nothing at all when the match sat past the window — while
    // both bundled drivers found it.
    const store = fromBaseStore(new InMemoryStore());
    for (let i = 0; i < 300; i += 1)
      await store.put(["ns"], `filler-${i}`, { text: "nothing here" });
    await store.put(["ns"], "late", { text: "hello world" });

    const found = await store.search({ query: "hello", limit: 10 });

    expect(found.map((item) => item.key)).toEqual(["late"]);
  });

  it("stamps a configured default TTL onto writes that name none", async () => {
    // `store.ttl.default_ttl` passes the startup capability check, so it has to actually reach a write —
    // otherwise the retention policy is accepted and then silently never applied.
    const puts: unknown[][] = [];
    class Recording extends InMemoryStore {
      sweepExpiredItems = async (): Promise<number> => 0;
      override async put(...args: unknown[]): Promise<void> {
        puts.push(args);
        await super.put(args[0] as string[], args[1] as string, args[2] as Record<string, unknown>);
      }
    }
    const store = fromBaseStore(new Recording(), { defaultTtl: 30 });

    await store.put(["ns"], "inherits", { v: 1 });
    await store.put(["ns"], "explicit", { v: 2 }, { ttl: 5 });

    // 5th argument is `PostgresStore`'s `{ ttl }` options bag; an explicit ttl wins over the default.
    expect(puts.map((args) => args[4])).toEqual([{ ttl: 30 }, { ttl: 5 }]);
  });

  it("does not let a scope-shaped prefix leak into a sibling tenant", async () => {
    // The concrete form of the case above, and the regression test for the design the proposal
    // originally sketched: `"@u:alice2:x".startsWith("@u:alice")` is true.
    const store = fromBaseStore(new InMemoryStore());
    await store.put(["@u", "alice"], "mine", { v: 1 });
    await store.put(["@u", "alice2"], "theirs", { v: 2 });

    const found = await store.search({ prefix: ["@u", "alice"] });

    expect(found.map((item) => item.key)).toEqual(["mine"]);
  });
});
