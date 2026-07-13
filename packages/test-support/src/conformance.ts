import { describe, it, expect } from "vitest";

/**
 * Minimal structural view of a SkeinStore, enough to seed the conformance suite.
 *
 * TODO(Phase 1): replace this with the real `SkeinStore` type imported from `@skein/core`
 * once it exists, and grow the suite to cover assistants, runs (status transitions,
 * concurrency guard), and store items (incl. semantic search). See docs/testing.md.
 */
export interface SkeinStoreLike {
  threads: {
    create(input?: { metadata?: Record<string, unknown> }): Promise<{ thread_id: string }>;
    get(id: string): Promise<{ thread_id: string } | null>;
    delete(id: string): Promise<void>;
  };
}

type StoreFactory = () => SkeinStoreLike | Promise<SkeinStoreLike>;

/**
 * Run the shared SkeinStore contract against a driver. Every storage driver
 * (memory, postgres, …) calls this so they are held to the identical behavior.
 *
 * @example
 * runSkeinStoreConformance("memory", () => new MemorySkeinStore());
 */
export function runSkeinStoreConformance(label: string, makeStore: StoreFactory): void {
  describe(`SkeinStore conformance — ${label}`, () => {
    it("creates a thread and reads it back by id", async () => {
      const store = await makeStore();
      const created = await store.threads.create({ metadata: { user: "a" } });

      expect(created.thread_id).toBeTruthy();
      const found = await store.threads.get(created.thread_id);
      expect(found?.thread_id).toBe(created.thread_id);
    });

    it("returns null for an unknown thread", async () => {
      const store = await makeStore();
      expect(await store.threads.get("does-not-exist")).toBeNull();
    });

    it("deletes a thread so it can no longer be read", async () => {
      const store = await makeStore();
      const { thread_id } = await store.threads.create();

      await store.threads.delete(thread_id);
      expect(await store.threads.get(thread_id)).toBeNull();
    });
  });
}
