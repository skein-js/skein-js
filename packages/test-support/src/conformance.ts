import type { SkeinStore } from "@skein-js/core";
import { describe, expect, it } from "vitest";

/**
 * Produces a fresh, empty {@link SkeinStore}. Called once per test so cases never share state.
 */
export type SkeinStoreFactory = () => SkeinStore | Promise<SkeinStore>;

/**
 * The single behavioral contract every SkeinStore driver must satisfy. Memory and Postgres run
 * the *same* suite, so they are provably interchangeable — swapping drivers can't change how
 * assistants, threads, runs, or the store behave. See docs/storage.md and docs/testing.md.
 *
 * @example
 * runSkeinStoreConformance("memory", () => new MemorySkeinStore());
 */
export function runSkeinStoreConformance(label: string, makeStore: SkeinStoreFactory): void {
  describe(`SkeinStore conformance — ${label}`, () => {
    describe("assistants", () => {
      it("creates an assistant, defaulting name to the graph id and version to 1", async () => {
        const store = await makeStore();
        const created = await store.assistants.create({ graph_id: "agent" });

        expect(created.assistant_id).toBeTruthy();
        expect(created.graph_id).toBe("agent");
        expect(created.name).toBe("agent");
        expect(created.version).toBe(1);
      });

      it("honors an explicit assistant_id, name, and description", async () => {
        const store = await makeStore();
        const created = await store.assistants.create({
          assistant_id: "fixed",
          graph_id: "agent",
          name: "My Agent",
          description: "does things",
        });

        expect(created.assistant_id).toBe("fixed");
        expect(created.name).toBe("My Agent");
        expect(created.description).toBe("does things");
      });

      it("reads an assistant back by id and lists it", async () => {
        const store = await makeStore();
        const { assistant_id } = await store.assistants.create({ graph_id: "agent" });

        expect((await store.assistants.get(assistant_id))?.assistant_id).toBe(assistant_id);
        expect((await store.assistants.list()).map((a) => a.assistant_id)).toContain(assistant_id);
      });

      it("returns null for an unknown assistant and removes on delete", async () => {
        const store = await makeStore();
        expect(await store.assistants.get("nope")).toBeNull();

        const { assistant_id } = await store.assistants.create({ graph_id: "agent" });
        await store.assistants.delete(assistant_id);
        expect(await store.assistants.get(assistant_id)).toBeNull();
      });
    });

    describe("threads", () => {
      it("creates a thread (idle by default) and reads it back by id", async () => {
        const store = await makeStore();
        const created = await store.threads.create({ metadata: { user: "a" } });

        expect(created.thread_id).toBeTruthy();
        expect(created.status).toBe("idle");
        const found = await store.threads.get(created.thread_id);
        expect(found?.thread_id).toBe(created.thread_id);
      });

      it("returns null for an unknown thread", async () => {
        const store = await makeStore();
        expect(await store.threads.get("does-not-exist")).toBeNull();
      });

      it("updates status, metadata, and values", async () => {
        const store = await makeStore();
        const { thread_id } = await store.threads.create();

        const updated = await store.threads.update(thread_id, {
          status: "interrupted",
          metadata: { k: "v" },
          values: { messages: [] },
        });
        expect(updated.status).toBe("interrupted");
        expect(updated.metadata).toMatchObject({ k: "v" });
        expect(updated.values).toEqual({ messages: [] });
      });

      it("mirrors pending interrupts onto the thread", async () => {
        const store = await makeStore();
        const { thread_id } = await store.threads.create();

        const interrupts = { task1: [{ value: "approve?", when: "during" as const }] };
        const updated = await store.threads.update(thread_id, { interrupts });
        expect(updated.interrupts).toEqual(interrupts);
      });

      it("rejects updating an unknown thread", async () => {
        const store = await makeStore();
        await expect(store.threads.update("nope", { status: "idle" })).rejects.toThrow();
      });

      it("deletes a thread so it can no longer be read", async () => {
        const store = await makeStore();
        const { thread_id } = await store.threads.create();

        await store.threads.delete(thread_id);
        expect(await store.threads.get(thread_id)).toBeNull();
      });

      it("searches threads by metadata subset", async () => {
        const store = await makeStore();
        await store.threads.create({ metadata: { user: "alice", tier: "pro" } });
        await store.threads.create({ metadata: { user: "bob", tier: "pro" } });
        await store.threads.create({ metadata: { user: "alice", tier: "free" } });

        const proAlice = await store.threads.search({ metadata: { user: "alice", tier: "pro" } });
        expect(proAlice).toHaveLength(1);
        expect(proAlice[0]?.metadata).toMatchObject({ user: "alice", tier: "pro" });

        const allPro = await store.threads.search({ metadata: { tier: "pro" } });
        expect(allPro).toHaveLength(2);

        // An empty filter matches every thread.
        expect(await store.threads.search({})).toHaveLength(3);
      });

      it("filters threads by graph via the graph_id metadata stamp", async () => {
        // The run engine stamps `graph_id`/`assistant_id` into thread metadata on run creation, so
        // "list the threads for graph X" is a plain metadata subset search (LangGraph-compatible).
        const store = await makeStore();
        await store.threads.create({ metadata: { graph_id: "chat", assistant_id: "a1" } });
        await store.threads.create({ metadata: { graph_id: "chat", assistant_id: "a2" } });
        await store.threads.create({ metadata: { graph_id: "research", assistant_id: "a3" } });

        const chatThreads = await store.threads.search({ metadata: { graph_id: "chat" } });
        expect(chatThreads).toHaveLength(2);
        expect(chatThreads.every((t) => t.metadata?.["graph_id"] === "chat")).toBe(true);

        const research = await store.threads.search({ metadata: { graph_id: "research" } });
        expect(research).toHaveLength(1);
      });

      it("matches nested metadata by deep containment (Postgres @> semantics)", async () => {
        const store = await makeStore();
        await store.threads.create({ metadata: { profile: { plan: "pro", region: "eu" } } });
        await store.threads.create({ metadata: { profile: { plan: "free", region: "eu" } } });

        // A partial nested filter must match a superset object — both drivers agree via `@>`.
        const pro = await store.threads.search({ metadata: { profile: { plan: "pro" } } });
        expect(pro).toHaveLength(1);
        expect(pro[0]?.metadata).toMatchObject({ profile: { plan: "pro", region: "eu" } });

        // A nested value that doesn't match excludes the row.
        expect(
          await store.threads.search({ metadata: { profile: { plan: "team" } } }),
        ).toHaveLength(0);
      });

      it("filters thread search by status and paginates with limit/offset", async () => {
        const store = await makeStore();
        const a = await store.threads.create();
        await store.threads.update(a.thread_id, { status: "interrupted" });
        await store.threads.create();
        await store.threads.create();

        const interrupted = await store.threads.search({ status: "interrupted" });
        expect(interrupted.map((t) => t.thread_id)).toEqual([a.thread_id]);

        const firstTwo = await store.threads.search({ limit: 2 });
        expect(firstTwo).toHaveLength(2);
        const nextOne = await store.threads.search({ limit: 2, offset: 2 });
        expect(nextOne).toHaveLength(1);
        // No overlap between the two pages.
        const ids = new Set(firstTwo.map((t) => t.thread_id));
        expect(ids.has(nextOne[0]?.thread_id ?? "")).toBe(false);
      });

      it("paginates deterministically when the sort key ties on every row", async () => {
        const store = await makeStore();
        const created: string[] = [];
        for (let i = 0; i < 5; i += 1) created.push((await store.threads.create()).thread_id);

        // Sort by `status` — every thread is "idle", so the primary key ties for all rows and paging
        // relies entirely on the thread_id tiebreaker. Walking every page must cover each row exactly
        // once (no drops, no duplicates).
        const seen: string[] = [];
        for (let offset = 0; offset < 5; offset += 2) {
          const page = await store.threads.search({ sortBy: "status", limit: 2, offset });
          seen.push(...page.map((t) => t.thread_id));
        }
        expect(seen).toHaveLength(5);
        expect(new Set(seen).size).toBe(5);
        expect([...seen].sort()).toEqual([...created].sort());
      });

      it("copies a thread into a new row carrying metadata, values, and status", async () => {
        const store = await makeStore();
        const source = await store.threads.create({ metadata: { user: "alice" } });
        await store.threads.update(source.thread_id, {
          status: "interrupted",
          values: { count: 3 },
        });

        const copy = await store.threads.copy(source.thread_id);
        expect(copy.thread_id).not.toBe(source.thread_id);
        expect(copy.metadata).toMatchObject({ user: "alice" });
        expect(copy.status).toBe("interrupted");
        expect(copy.values).toMatchObject({ count: 3 });
        // The original is untouched and both now exist.
        expect(await store.threads.get(source.thread_id)).not.toBeNull();
        expect(await store.threads.get(copy.thread_id)).not.toBeNull();
      });

      it("rejects copying an unknown thread", async () => {
        const store = await makeStore();
        await expect(store.threads.copy("nope")).rejects.toThrow();
      });
    });

    describe("runs", () => {
      const seedThread = async (store: SkeinStore): Promise<string> =>
        (await store.threads.create()).thread_id;

      it("creates a run in pending status by default", async () => {
        const store = await makeStore();
        const thread_id = await seedThread(store);
        const run = await store.runs.create({ thread_id, assistant_id: "a" });

        expect(run.run_id).toBeTruthy();
        expect(run.status).toBe("pending");
        expect(run.thread_id).toBe(thread_id);
      });

      it("reads a run back and lists runs by thread", async () => {
        const store = await makeStore();
        const thread_id = await seedThread(store);
        const run = await store.runs.create({ thread_id, assistant_id: "a" });

        expect((await store.runs.get(run.run_id))?.run_id).toBe(run.run_id);
        expect((await store.runs.listByThread(thread_id)).map((r) => r.run_id)).toEqual([
          run.run_id,
        ]);
      });

      it("transitions run status", async () => {
        const store = await makeStore();
        const thread_id = await seedThread(store);
        const run = await store.runs.create({ thread_id, assistant_id: "a" });

        expect((await store.runs.setStatus(run.run_id, "running")).status).toBe("running");
        expect((await store.runs.setStatus(run.run_id, "success")).status).toBe("success");
      });

      it("rejects setting status on an unknown run", async () => {
        const store = await makeStore();
        await expect(store.runs.setStatus("nope", "running")).rejects.toThrow();
      });

      it("reports an active run via the concurrency guard until it reaches a terminal status", async () => {
        const store = await makeStore();
        const thread_id = await seedThread(store);
        expect(await store.runs.hasActiveRun(thread_id)).toBe(false);

        const run = await store.runs.create({ thread_id, assistant_id: "a" });
        expect(await store.runs.hasActiveRun(thread_id)).toBe(true);

        await store.runs.setStatus(run.run_id, "running");
        expect(await store.runs.hasActiveRun(thread_id)).toBe(true);

        await store.runs.setStatus(run.run_id, "success");
        expect(await store.runs.hasActiveRun(thread_id)).toBe(false);
      });

      it("does not count an interrupted run as active (resume is a fresh run on the thread)", async () => {
        // Matches @langchain/langgraph-api: inflight = pending | running only. An interrupted run
        // has handed the thread to a human, so it is terminal and must not block the resume run.
        const store = await makeStore();
        const thread_id = await seedThread(store);
        const run = await store.runs.create({ thread_id, assistant_id: "a" });

        await store.runs.setStatus(run.run_id, "interrupted");
        expect(await store.runs.hasActiveRun(thread_id)).toBe(false);
      });

      it("round-trips a run's opaque kwargs and returns null for an unknown run", async () => {
        const store = await makeStore();
        const thread_id = await seedThread(store);
        const run = await store.runs.create({
          thread_id,
          assistant_id: "a",
          kwargs: { input: { messages: ["hi"] }, stream_mode: "values" },
        });

        expect(await store.runs.getKwargs(run.run_id)).toEqual({
          input: { messages: ["hi"] },
          stream_mode: "values",
        });
        expect(await store.runs.getKwargs("unknown")).toBeNull();

        const noKwargs = await store.runs.create({ thread_id, assistant_id: "a" });
        expect(await store.runs.getKwargs(noKwargs.run_id)).toBeNull();
      });

      it("deletes a run", async () => {
        const store = await makeStore();
        const thread_id = await seedThread(store);
        const run = await store.runs.create({ thread_id, assistant_id: "a" });

        await store.runs.delete(run.run_id);
        expect(await store.runs.get(run.run_id)).toBeNull();
      });

      it("cascades: deleting a thread removes its runs", async () => {
        const store = await makeStore();
        const thread_id = await seedThread(store);
        await store.runs.create({ thread_id, assistant_id: "a" });

        await store.threads.delete(thread_id);
        expect(await store.runs.listByThread(thread_id)).toEqual([]);
        expect(await store.runs.hasActiveRun(thread_id)).toBe(false);
      });
    });

    describe("store (long-term memory)", () => {
      it("puts and gets an item by namespace + key", async () => {
        const store = await makeStore();
        const item = await store.store.put(["users", "1"], "profile", { name: "Ada" });

        expect(item.namespace).toEqual(["users", "1"]);
        expect(item.key).toBe("profile");
        const found = await store.store.get(["users", "1"], "profile");
        expect(found?.value).toEqual({ name: "Ada" });
      });

      it("upsert preserves createdAt and returns null after delete", async () => {
        const store = await makeStore();
        const first = await store.store.put(["ns"], "k", { v: 1 });
        const second = await store.store.put(["ns"], "k", { v: 2 });

        expect(second.createdAt).toBe(first.createdAt);
        expect(second.value).toEqual({ v: 2 });

        await store.store.delete(["ns"], "k");
        expect(await store.store.get(["ns"], "k")).toBeNull();
      });

      it("searches by namespace prefix", async () => {
        const store = await makeStore();
        await store.store.put(["users", "1"], "a", { x: 1 });
        await store.store.put(["users", "2"], "b", { x: 2 });
        await store.store.put(["orgs", "1"], "c", { x: 3 });

        const users = await store.store.search({ prefix: ["users"] });
        expect(users).toHaveLength(2);
        expect(users.every((i) => i.namespace[0] === "users")).toBe(true);
      });

      it("filters search by a naive text query", async () => {
        const store = await makeStore();
        await store.store.put(["ns"], "a", { text: "hello world" });
        await store.store.put(["ns"], "b", { text: "goodbye" });

        const hits = await store.store.search({ query: "hello" });
        expect(hits).toHaveLength(1);
        expect(hits[0]?.key).toBe("a");
      });

      it("lists distinct namespaces, filtered by prefix", async () => {
        const store = await makeStore();
        await store.store.put(["users", "1"], "a", {});
        await store.store.put(["users", "1"], "b", {});
        await store.store.put(["orgs", "1"], "c", {});

        const all = await store.store.listNamespaces();
        expect(all).toHaveLength(2);
        const users = await store.store.listNamespaces(["users"]);
        expect(users).toEqual([["users", "1"]]);
      });

      it("does not collide namespaces whose segments contain a separator", async () => {
        const store = await makeStore();
        await store.store.put(["a", "b"], "k1", {});
        await store.store.put(["a/b"], "k2", {});
        // Distinct namespaces `["a","b"]` and `["a/b"]` must both be listed, not merged.
        expect(await store.store.listNamespaces()).toHaveLength(2);
      });
    });

    describe("store TTL", () => {
      // A tiny fractional-minute TTL (~40ms) keeps the expiry tests fast and deterministic.
      const tinyTtlMinutes = 40 / 60_000;
      const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

      it("keeps an item with no TTL and does not sweep it", async () => {
        const store = await makeStore();
        await store.store.put(["ns"], "keep", { v: 1 });

        expect(await store.store.sweepExpired()).toBe(0);
        expect(await store.store.get(["ns"], "keep")).not.toBeNull();
      });

      it("expires a per-put TTL item: reads null and the sweeper removes it", async () => {
        const store = await makeStore();
        await store.store.put(["ns"], "gone", { v: 1 }, { ttl: tinyTtlMinutes });

        await wait(120);
        // Lazy expiry: an expired item reads as absent even before the sweep runs.
        expect(await store.store.get(["ns"], "gone")).toBeNull();
        // And it is no longer surfaced by search or namespace listing.
        expect(await store.store.search({ prefix: ["ns"] })).toHaveLength(0);
        // The sweeper physically deletes remaining expired rows (idempotent afterwards).
        await store.store.sweepExpired();
        expect(await store.store.sweepExpired()).toBe(0);
      });
    });

    // A driver must isolate stored rows from caller objects (a real DB serializes them); the
    // memory driver deep-clones to match, so swapping drivers can't change mutation semantics.
    describe("driver parity — isolation", () => {
      it("does not leak mutations of a returned object back into the store", async () => {
        const store = await makeStore();
        const { thread_id } = await store.threads.create({ metadata: { pinned: true } });

        const got = await store.threads.get(thread_id);
        if (got) (got.metadata as { pinned?: boolean }).pinned = false;

        const again = await store.threads.get(thread_id);
        expect((again?.metadata as { pinned?: boolean }).pinned).toBe(true);
      });

      it("does not let later mutation of the create input reach the store", async () => {
        const store = await makeStore();
        const metadata = { pinned: true };
        const { thread_id } = await store.threads.create({ metadata });

        metadata.pinned = false;

        const again = await store.threads.get(thread_id);
        expect((again?.metadata as { pinned?: boolean }).pinned).toBe(true);
      });

      it("isolates stored store-item values from a returned object", async () => {
        const store = await makeStore();
        await store.store.put(["ns"], "k", { n: 1 });

        const got = await store.store.get(["ns"], "k");
        if (got) (got.value as { n: number }).n = 2;

        const again = await store.store.get(["ns"], "k");
        expect((again?.value as { n: number } | undefined)?.n).toBe(1);
      });
    });
  });
}
