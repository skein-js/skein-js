import type { SkeinStore, StoreTtlConfig } from "@skein-js/core";
import { describe, expect, it } from "vitest";

/** Additive store capabilities; deliberately separate from the contract existing custom drivers implement. */
export function runStoreOptionsConformance(
  label: string,
  factory: (ttl?: StoreTtlConfig) => SkeinStore | Promise<SkeinStore>,
): void {
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  describe(`${label} store operation options`, () => {
    it("keeps explicit no-expiry writes under a configured default TTL", async () => {
      const repo = (await factory({ defaultTtl: 40 / 60_000 })).store;
      await repo.putWithOptions!(["options"], "pinned", { value: true }, { ttl: null });
      await repo.put(["options"], "default", { value: true });
      await pause(120);
      expect(await repo.get(["options"], "pinned")).not.toBeNull();
      expect(await repo.get(["options"], "default")).toBeNull();
    });

    it("refreshes only when requested, overriding the configured get/search policy", async () => {
      const repo = (await factory({ defaultTtl: 1_000 / 60_000, refreshOnRead: false })).store;
      await repo.put(["refresh"], "one", { value: true });
      await pause(600);
      expect(await repo.get(["refresh"], "one", { refreshTtl: true })).not.toBeNull();
      await pause(600);
      expect(await repo.get(["refresh"], "one", { refreshTtl: false })).not.toBeNull();
      await pause(600);
      expect(await repo.get(["refresh"], "one", { refreshTtl: false })).toBeNull();
    });

    it("does not refresh search results when a read explicitly opts out", async () => {
      const repo = (await factory({ defaultTtl: 1_000 / 60_000, refreshOnRead: true })).store;
      await repo.put(["search"], "one", { value: true });
      await pause(600);
      expect(await repo.search({ prefix: ["search"], refreshTtl: false })).toHaveLength(1);
      await pause(600);
      expect(await repo.get(["search"], "one", { refreshTtl: false })).toBeNull();
    });

    it("honors item indexing choices while retaining ordinary item reads", async () => {
      const repo = (await factory()).store;
      await repo.putWithOptions!(
        ["index"],
        "selected",
        { title: "visible", body: "hidden" },
        { index: ["title"] },
      );
      await repo.putWithOptions!(["index"], "disabled", { title: "visible" }, { index: false });
      expect(
        (await repo.search({ prefix: ["index"], query: "visible" })).map((item) => item.key),
      ).toEqual(["selected"]);
      expect(await repo.search({ prefix: ["index"], query: "hidden" })).toHaveLength(0);
      expect(await repo.get(["index"], "disabled")).not.toBeNull();
    });

    it("excludes metadata before pagination and preserves exact-name repository defaults", async () => {
      const store = await factory();
      await store.threads.create({ thread_id: "a", metadata: { archived: true } });
      await store.threads.create({ thread_id: "b", metadata: { archived: false } });
      await store.threads.create({ thread_id: "c", metadata: { hidden: true } });
      expect(
        (
          await store.threads.search({
            excludeMetadata: [{ archived: true }, { hidden: true }],
            limit: 1,
            sortBy: "thread_id",
            sortOrder: "asc",
          })
        ).map((thread) => thread.thread_id),
      ).toEqual(["b"]);
      expect(
        await store.threads.count({ excludeMetadata: [{ archived: true }, { hidden: true }] }),
      ).toBe(1);
      await store.assistants.create({ graph_id: "test", name: "My Agent" });
      expect(await store.assistants.search({ name: "agent" })).toHaveLength(0);
      expect(await store.assistants.search({ name: "agent", nameMatch: "substring" })).toHaveLength(
        1,
      );
    });
  });
}
