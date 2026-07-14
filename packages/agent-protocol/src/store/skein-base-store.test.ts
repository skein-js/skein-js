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
});
