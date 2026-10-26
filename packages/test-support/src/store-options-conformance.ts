import type { SkeinStore, StoreTtlConfig } from "@skein-js/core";
import { describe, expect, it } from "vitest";

/** Additive store capabilities; deliberately separate from the contract existing custom drivers implement. */
export function runStoreOptionsConformance(
  label: string,
  factory: (ttl?: StoreTtlConfig) => SkeinStore | Promise<SkeinStore>,
): void {
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  describe(`${label} store operation options`, () => {
    it("projects saved retention and refreshed expiry consistently on get and search", async () => {
      const store = await factory({ defaultTtl: 60, refreshOnRead: false });
      const written = await store.store.put(["retention"], "item", { value: true }, { ttl: 30 });
      expect(written.ttl).toBe(30);
      expect(Date.parse(written.expiresAt!)).toBeGreaterThan(Date.now());
      const passive = await store.store.get(["retention"], "item", { refreshTtl: false });
      expect(passive?.expiresAt).toBe(written.expiresAt);
      await pause(20);
      const refreshed = await store.store.search({ prefix: ["retention"], refreshTtl: true });
      expect(Date.parse(refreshed[0]!.expiresAt!)).toBeGreaterThan(Date.parse(written.expiresAt!));
      expect((await store.store.get(["retention"], "item", { refreshTtl: false }))?.expiresAt).toBe(
        refreshed[0]!.expiresAt,
      );
      const pinned = await store.store.putWithOptions!(["retention"], "pinned", {}, { ttl: null });
      expect(pinned).toMatchObject({ ttl: null, expiresAt: null });
      const thread = await store.threads.create({ ttl: 30, ttlStrategy: "keep_latest" });
      expect(thread).toMatchObject({ ttl: 30, ttl_strategy: "keep_latest" });
      expect(Date.parse(thread.expires_at!)).toBeGreaterThan(Date.now());
      expect((await store.threads.search({ ids: [thread.thread_id] }))[0]?.expires_at).toBe(
        thread.expires_at,
      );
      expect(await store.threads.update(thread.thread_id, { ttl: null })).toMatchObject({
        ttl: null,
        expires_at: null,
      });
    });

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
