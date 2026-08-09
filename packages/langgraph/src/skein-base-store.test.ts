import { MemorySkeinStore } from "@skein-js/storage-memory";
import { describe, expect, it } from "vitest";

import { SkeinBaseStore } from "./skein-base-store.js";

describe("SkeinBaseStore", () => {
  const newStore = () => new SkeinBaseStore(new MemorySkeinStore().store);

  it("puts and gets an item, exposing timestamps as Date instances", async () => {
    const store = newStore();
    await store.put(["users", "1"], "profile", { name: "Ada" });

    const item = await store.get(["users", "1"], "profile");
    expect(item?.value).toEqual({ name: "Ada" });
    expect(item?.namespace).toEqual(["users", "1"]);
    expect(item?.key).toBe("profile");
    // The wire item carries ISO strings; the BaseStore contract is Date.
    expect(item?.createdAt).toBeInstanceOf(Date);
    expect(item?.updatedAt).toBeInstanceOf(Date);
  });

  it("returns null for a missing item", async () => {
    expect(await newStore().get(["nope"], "missing")).toBeNull();
  });

  it("searches within a namespace prefix", async () => {
    const store = newStore();
    await store.put(["memories", "u1"], "a", { text: "likes tea" });
    await store.put(["memories", "u1"], "b", { text: "likes coffee" });
    await store.put(["memories", "u2"], "c", { text: "elsewhere" });

    const hits = await store.search(["memories", "u1"]);
    expect(hits.map((h) => h.key).sort()).toEqual(["a", "b"]);
    expect(hits[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("lists namespaces under a prefix", async () => {
    const store = newStore();
    await store.put(["memories", "u1"], "a", { text: "x" });
    expect(await store.listNamespaces({ prefix: ["memories"] })).toEqual([["memories", "u1"]]);
  });

  it("deletes an item", async () => {
    const store = newStore();
    await store.put(["k"], "one", { v: 1 });
    await store.delete(["k"], "one");
    expect(await store.get(["k"], "one")).toBeNull();
  });

  it("dispatches mixed operations through batch()", async () => {
    const store = newStore();
    // The precise per-op result typing isn't the point here; assert the runtime dispatch.
    const [putResult, getResult, searchResult, namespaces] = (await store.batch([
      { namespace: ["docs"], key: "r1", value: { title: "Report" } },
      { namespace: ["docs"], key: "r1" },
      { namespacePrefix: ["docs"] },
      { matchConditions: [{ matchType: "prefix", path: ["docs"] }], limit: 10, offset: 0 },
    ])) as unknown as [void, { value: unknown } | null, unknown[], string[][]];

    expect(putResult).toBeUndefined();
    expect(getResult?.value).toEqual({ title: "Report" });
    expect(searchResult).toHaveLength(1);
    expect(namespaces).toEqual([["docs"]]);
  });

  it("treats a null-valued put operation as a delete", async () => {
    const store = newStore();
    await store.put(["k"], "one", { v: 1 });
    await store.batch([{ namespace: ["k"], key: "one", value: null }]);
    expect(await store.get(["k"], "one")).toBeNull();
  });

  it("narrows a wildcard namespace prefix instead of returning everything", async () => {
    const store = newStore();
    await store.put(["users", "1"], "a", { v: 1 });
    await store.put(["users", "2"], "b", { v: 2 });
    await store.put(["orgs", "acme"], "c", { v: 3 });

    // A wildcard used to be dropped, leaving the repo with no prefix — so this returned `["orgs"]`
    // too, leaking namespace names across tenants.
    expect(await store.listNamespaces({ prefix: ["users", "*"] })).toEqual([
      ["users", "1"],
      ["users", "2"],
    ]);
  });

  it("carries suffix and maxDepth to the repo", async () => {
    const store = newStore();
    await store.put(["users", "1", "facts"], "a", { v: 1 });
    await store.put(["users", "2", "notes"], "b", { v: 2 });

    expect(await store.listNamespaces({ suffix: ["facts"] })).toEqual([["users", "1", "facts"]]);
    expect(await store.listNamespaces({ maxDepth: 1 })).toEqual([["users"]]);
  });

  it("narrows a search by filter", async () => {
    const store = newStore();
    await store.put(["docs"], "a", { shelf: 1 });
    await store.put(["docs"], "b", { shelf: 2 });

    const hits = await store.search(["docs"], { filter: { shelf: { $gt: 1 } } });
    expect(hits.map((hit) => hit.key)).toEqual(["b"]);
  });

  // This path has no schema in front of it — a graph node's filter reaches the driver directly. On
  // Postgres an unchecked operand is a *crash* (`invalid input syntax for type numeric`), i.e. a 500
  // from inside a run, so it is validated here against the same rules the HTTP boundary applies.
  it("refuses a malformed filter rather than passing it to the driver", async () => {
    const store = newStore();

    for (const filter of [
      { shelf: { $gt: "1" } },
      { shelf: { $in: "abc" } },
      { shelf: { $gtt: 1 } },
      { tags: ["work"] },
    ]) {
      await expect(store.search(["docs"], { filter })).rejects.toMatchObject({ status: 400 });
    }
  });

  it("bounds listNamespaces at 100 by default, matching BaseStore", async () => {
    const store = new SkeinBaseStore(new MemorySkeinStore({ maxPageSize: 2 }).store);
    await store.put(["a"], "1", {});
    await store.put(["b"], "2", {});
    await store.put(["c"], "3", {});

    // The driver's own bound still applies; the point is that an absent limit is a page, not a scan.
    expect(await store.listNamespaces()).toHaveLength(2);
  });

  it("honours limit, offset and maxDepth on a batch listNamespaces operation", async () => {
    const store = newStore();
    await store.put(["users", "1"], "a", {});
    await store.put(["users", "2"], "b", {});
    await store.put(["users", "3"], "c", {});

    // `limit`/`offset` are required fields on `ListNamespacesOperation` and were dropped outright, so
    // a graph's `store.listNamespaces({ limit: 10 })` read every namespace in the store.
    const [page] = (await store.batch([
      { matchConditions: [{ matchType: "prefix", path: ["users"] }], limit: 1, offset: 1 },
    ])) as unknown as [string[][]];

    expect(page).toEqual([["users", "2"]]);
  });
});
