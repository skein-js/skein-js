import type { SkeinStore, Thread } from "@skein-js/core";
import { describe, expect, it } from "vitest";

/** Driver-agnostic knobs the conformance suite needs to set on the store it is handed. */
export interface ConformanceStoreOptions {
  /**
   * The driver's page bound. The suite sets a tiny value to assert the bound is applied without
   * inserting a thousand rows, so every driver has to accept it.
   */
  maxPageSize?: number;
}

/**
 * Produces a fresh, empty {@link SkeinStore}. Called once per test so cases never share state.
 * `options` is passed through to the driver's constructor.
 */
export type SkeinStoreFactory = (
  options?: ConformanceStoreOptions,
) => SkeinStore | Promise<SkeinStore>;

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

      it("seeds version 1 on create and lists it", async () => {
        const store = await makeStore();
        const { assistant_id } = await store.assistants.create({
          graph_id: "agent",
          metadata: { env: "dev" },
        });

        const versions = await store.assistants.listVersions(assistant_id);
        expect(versions).toHaveLength(1);
        expect(versions[0]).toMatchObject({
          version: 1,
          graph_id: "agent",
          metadata: { env: "dev" },
        });
      });

      it("mints a new version on update, mirroring the patched fields onto the live row", async () => {
        const store = await makeStore();
        const { assistant_id } = await store.assistants.create({
          graph_id: "agent",
          name: "v1",
          metadata: { env: "dev" },
        });

        const updated = await store.assistants.update(assistant_id, {
          name: "v2",
          metadata: { env: "prod" },
        });
        expect(updated.version).toBe(2);
        expect(updated.name).toBe("v2");
        expect(updated.metadata).toEqual({ env: "prod" });
        // graph_id was not patched, so it carries over from v1.
        expect(updated.graph_id).toBe("agent");

        const live = await store.assistants.get(assistant_id);
        expect(live).toMatchObject({ version: 2, name: "v2" });
      });

      it("rejects updating an unknown assistant", async () => {
        const store = await makeStore();
        await expect(store.assistants.update("nope", { name: "x" })).rejects.toThrow();
      });

      it("lists version history newest-first, with pagination", async () => {
        const store = await makeStore();
        const { assistant_id } = await store.assistants.create({ graph_id: "agent", name: "v1" });
        await store.assistants.update(assistant_id, { name: "v2" });
        await store.assistants.update(assistant_id, { name: "v3" });

        const all = await store.assistants.listVersions(assistant_id);
        expect(all.map((v) => v.version)).toEqual([3, 2, 1]);
        expect(all.map((v) => v.name)).toEqual(["v3", "v2", "v1"]);

        const page = await store.assistants.listVersions(assistant_id, { limit: 1, offset: 1 });
        expect(page.map((v) => v.version)).toEqual([2]);
      });

      it("filters version history by metadata subset", async () => {
        const store = await makeStore();
        const { assistant_id } = await store.assistants.create({
          graph_id: "agent",
          metadata: { env: "dev" },
        });
        await store.assistants.update(assistant_id, { metadata: { env: "prod" } });

        const prod = await store.assistants.listVersions(assistant_id, {
          metadata: { env: "prod" },
        });
        expect(prod.map((v) => v.version)).toEqual([2]);
      });

      it("rolls back to an existing version via setLatest without minting a new one", async () => {
        const store = await makeStore();
        const { assistant_id } = await store.assistants.create({
          graph_id: "agent",
          metadata: { env: "dev" },
        });
        await store.assistants.update(assistant_id, { metadata: { env: "prod" } });

        const rolledBack = await store.assistants.setLatest(assistant_id, 1);
        expect(rolledBack.version).toBe(1);
        expect(rolledBack.metadata).toEqual({ env: "dev" });
        // No new version was created; history still holds exactly v1 and v2.
        expect((await store.assistants.listVersions(assistant_id)).map((v) => v.version)).toEqual([
          2, 1,
        ]);
      });

      it("rejects setLatest to an unknown version", async () => {
        const store = await makeStore();
        const { assistant_id } = await store.assistants.create({ graph_id: "agent" });
        await expect(store.assistants.setLatest(assistant_id, 99)).rejects.toThrow();
      });

      it("mints max+1 (not a colliding version) when updating after a setLatest rollback", async () => {
        const store = await makeStore();
        const { assistant_id } = await store.assistants.create({ graph_id: "agent", name: "v1" });
        await store.assistants.update(assistant_id, { name: "v2" }); // version 2
        await store.assistants.setLatest(assistant_id, 1); // live back to version 1

        // The next update must be version 3 (max+1), not 2 (active+1) — active+1 would collide with
        // the existing v2 snapshot (Postgres PK violation / memory silent overwrite).
        const next = await store.assistants.update(assistant_id, { name: "v3" });
        expect(next.version).toBe(3);
        expect(next.name).toBe("v3");
        const versions = await store.assistants.listVersions(assistant_id);
        expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
        // The original v2 snapshot is intact (not overwritten).
        expect(versions.find((v) => v.version === 2)?.name).toBe("v2");
      });

      it("merges metadata on update, preserving sibling keys (LangGraph parity)", async () => {
        const store = await makeStore();
        const { assistant_id } = await store.assistants.create({
          graph_id: "agent",
          metadata: { team: "core", owner: "ada" },
        });

        const updated = await store.assistants.update(assistant_id, { metadata: { env: "prod" } });
        expect(updated.metadata).toEqual({ team: "core", owner: "ada", env: "prod" });
        // The version snapshot records the merged metadata too.
        const [latest] = await store.assistants.listVersions(assistant_id);
        expect(latest?.metadata).toEqual({ team: "core", owner: "ada", env: "prod" });
      });

      it("rejects creating a duplicate assistant_id", async () => {
        const store = await makeStore();
        await store.assistants.create({ assistant_id: "dup", graph_id: "agent" });
        await expect(
          store.assistants.create({ assistant_id: "dup", graph_id: "agent" }),
        ).rejects.toThrow();
      });

      it("cascades version history on delete", async () => {
        const store = await makeStore();
        const { assistant_id } = await store.assistants.create({ graph_id: "agent" });
        await store.assistants.update(assistant_id, { name: "v2" });

        await store.assistants.delete(assistant_id);
        expect(await store.assistants.listVersions(assistant_id)).toHaveLength(0);
      });

      it("searches by graph_id, name, and metadata subset, and counts matches", async () => {
        const store = await makeStore();
        await store.assistants.create({
          graph_id: "agent",
          name: "one",
          metadata: { team: "core" },
        });
        await store.assistants.create({
          graph_id: "agent",
          name: "two",
          metadata: { team: "ops" },
        });
        await store.assistants.create({
          graph_id: "other",
          name: "three",
          metadata: { team: "core" },
        });

        expect(await store.assistants.search({ graph_id: "agent" })).toHaveLength(2);
        expect(await store.assistants.search({ name: "two" })).toHaveLength(1);
        expect(await store.assistants.search({ metadata: { team: "core" } })).toHaveLength(2);
        // An empty filter matches everything.
        expect(await store.assistants.search({})).toHaveLength(3);

        expect(await store.assistants.count({ metadata: { team: "core" } })).toBe(2);
        expect(await store.assistants.count({ graph_id: "agent" })).toBe(2);
        expect(await store.assistants.count({})).toBe(3);
      });

      it("sorts and paginates search results deterministically", async () => {
        const store = await makeStore();
        await store.assistants.create({ assistant_id: "a", graph_id: "g", name: "alpha" });
        await store.assistants.create({ assistant_id: "b", graph_id: "g", name: "bravo" });
        await store.assistants.create({ assistant_id: "c", graph_id: "g", name: "charlie" });

        const ascending = await store.assistants.search({ sortBy: "name", sortOrder: "asc" });
        expect(ascending.map((a) => a.name)).toEqual(["alpha", "bravo", "charlie"]);

        const firstPage = await store.assistants.search({
          sortBy: "name",
          sortOrder: "asc",
          limit: 2,
        });
        expect(firstPage.map((a) => a.name)).toEqual(["alpha", "bravo"]);
        const secondPage = await store.assistants.search({
          sortBy: "name",
          sortOrder: "asc",
          limit: 2,
          offset: 2,
        });
        expect(secondPage.map((a) => a.name)).toEqual(["charlie"]);
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

      // Both drivers must answer a duplicate id the same way. Memory silently *overwrote* the thread
      // (resetting created_at/metadata/status/values/interrupts) while Postgres let a raw `pg` unique
      // violation escape as a 500 — neither is `if_exists`, and neither matched the other.
      it("rejects a duplicate thread id as a conflict", async () => {
        const store = await makeStore();
        await store.threads.create({ thread_id: "fixed" });

        await expect(store.threads.create({ thread_id: "fixed" })).rejects.toMatchObject({
          status: 409,
        });
      });

      it("leaves the existing thread untouched when a duplicate create is rejected", async () => {
        const store = await makeStore();
        await store.threads.create({ thread_id: "fixed", metadata: { keep: "me" } });
        await store.threads.update("fixed", {
          status: "interrupted",
          values: { messages: ["hi"] },
        });

        await expect(store.threads.create({ thread_id: "fixed" })).rejects.toMatchObject({
          status: 409,
        });

        // The clobber this guards against reset every one of these.
        const after = await store.threads.get("fixed");
        expect(after?.status).toBe("interrupted");
        expect(after?.metadata).toMatchObject({ keep: "me" });
        expect(after?.values).toEqual({ messages: ["hi"] });
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

      it("mirrors why a thread failed, and clears it when the thread recovers", async () => {
        const store = await makeStore();
        const { thread_id } = await store.threads.create();

        expect((await store.threads.get(thread_id))?.error).toBeUndefined();

        const failed = await store.threads.update(thread_id, { status: "error", error: "boom" });
        expect(failed.error).toBe("boom");
        expect((await store.threads.get(thread_id))?.error).toBe("boom");

        // An update that doesn't mention `error` leaves it alone...
        const untouched = await store.threads.update(thread_id, { metadata: { a: 1 } });
        expect(untouched.error).toBe("boom");

        // ...and an explicit null clears it.
        const recovered = await store.threads.update(thread_id, { status: "idle", error: null });
        expect(recovered.error).toBeUndefined();
        expect((await store.threads.get(thread_id))?.error).toBeUndefined();
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

      it("counts threads with exactly the filters search applies", async () => {
        // `POST /threads/count`. The two share a WHERE builder in the Postgres driver and a matcher in
        // the memory one precisely so they cannot drift — a count that disagrees with its own listing
        // reads as a race rather than as the bug it is.
        const store = await makeStore();
        const busy = await store.threads.create({ metadata: { graph_id: "chat" } });
        await store.threads.update(busy.thread_id, { status: "busy", values: { turns: 2 } });
        await store.threads.create({ metadata: { graph_id: "chat" } });
        await store.threads.create({ metadata: { graph_id: "research" } });

        const filters = [
          {},
          { metadata: { graph_id: "chat" } },
          { metadata: { graph_id: "nope" } },
          { status: "busy" as const },
          { values: { turns: 2 } },
          { ids: [busy.thread_id] },
        ];
        for (const filter of filters) {
          expect(await store.threads.count(filter)).toBe(
            (await store.threads.search(filter)).length,
          );
        }
        expect(await store.threads.count({})).toBe(3);
        expect(await store.threads.count({ metadata: { graph_id: "chat" } })).toBe(2);
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

      it("pages runs by thread", async () => {
        const store = await makeStore();
        const thread_id = await seedThread(store);
        for (let index = 0; index < 3; index += 1) {
          await store.runs.create({ thread_id, assistant_id: "a" });
        }
        const all = await store.runs.listByThread(thread_id);
        expect(await store.runs.listByThread(thread_id, { offset: 1, limit: 1 })).toEqual([all[1]]);
      });

      it("filters runs by status, before paging", async () => {
        const store = await makeStore();
        const thread_id = await seedThread(store);
        const first = await store.runs.create({ thread_id, assistant_id: "a" });
        const second = await store.runs.create({ thread_id, assistant_id: "a" });
        const third = await store.runs.create({ thread_id, assistant_id: "a" });
        await store.runs.setStatus(first.run_id, "success");
        await store.runs.setStatus(third.run_id, "success");

        expect(
          (await store.runs.listByThread(thread_id, { status: "success" })).map((r) => r.run_id),
        ).toEqual([first.run_id, third.run_id]);
        expect(
          (await store.runs.listByThread(thread_id, { status: "pending" })).map((r) => r.run_id),
        ).toEqual([second.run_id]);

        // The filter must be applied *before* the page bound, or `limit`/`offset` would describe the
        // unfiltered set and page 2 of "the successful runs" would skip rows it never returned.
        expect(
          (
            await store.runs.listByThread(thread_id, { status: "success", offset: 1, limit: 1 })
          ).map((r) => r.run_id),
        ).toEqual([third.run_id]);
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

      it("leaves error absent on a run that never failed", async () => {
        const store = await makeStore();
        const thread_id = await seedThread(store);
        const run = await store.runs.create({ thread_id, assistant_id: "a" });

        expect((await store.runs.get(run.run_id))?.error).toBeUndefined();
        await store.runs.setStatus(run.run_id, "success");
        expect((await store.runs.get(run.run_id))?.error).toBeUndefined();
      });

      it("records why a run failed, including the cause chain", async () => {
        const store = await makeStore();
        const thread_id = await seedThread(store);
        const run = await store.runs.create({ thread_id, assistant_id: "a" });
        const failure = {
          error: "TypeError",
          name: "TypeError",
          message: "model call failed",
          cause: { error: "Error", name: "Error", message: "429 rate limit" },
        };

        expect((await store.runs.setStatus(run.run_id, "error", failure)).error).toEqual(failure);
        expect((await store.runs.get(run.run_id))?.error).toEqual(failure);
        // listByThread is a separate read path in the Postgres driver, so assert through it too.
        const listed = await store.runs.listByThread(thread_id);
        expect(listed.find((each) => each.run_id === run.run_id)?.error).toEqual(failure);
      });

      it("clears a stored error when the status moves on without one", async () => {
        const store = await makeStore();
        const thread_id = await seedThread(store);
        const run = await store.runs.create({ thread_id, assistant_id: "a" });

        await store.runs.setStatus(run.run_id, "error", {
          error: "Error",
          name: "Error",
          message: "boom",
        });
        await store.runs.setStatus(run.run_id, "success");
        expect((await store.runs.get(run.run_id))?.error).toBeUndefined();
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

      it("lists only the thread's inflight runs (pending | running)", async () => {
        // The multitask engine reads these to interrupt/rollback them when a second run arrives.
        const store = await makeStore();
        const thread_id = await seedThread(store);
        expect(await store.runs.listActiveRuns(thread_id)).toEqual([]);

        const pending = await store.runs.create({ thread_id, assistant_id: "a" });
        const running = await store.runs.create({ thread_id, assistant_id: "a" });
        await store.runs.setStatus(running.run_id, "running");
        const done = await store.runs.create({ thread_id, assistant_id: "a" });
        await store.runs.setStatus(done.run_id, "success");

        const active = await store.runs.listActiveRuns(thread_id);
        expect(active.map((run) => run.run_id).sort()).toEqual(
          [pending.run_id, running.run_id].sort(),
        );

        // Terminal runs drop out; a distinct thread's runs never leak in.
        await store.runs.setStatus(pending.run_id, "cancelled");
        await store.runs.setStatus(running.run_id, "interrupted");
        expect(await store.runs.listActiveRuns(thread_id)).toEqual([]);
      });

      it("records a base checkpoint onto a run's kwargs, keeping the rest intact", async () => {
        const store = await makeStore();
        const thread_id = await seedThread(store);
        const run = await store.runs.create({
          thread_id,
          assistant_id: "a",
          kwargs: { input: { messages: ["hi"] }, stream_mode: "values" },
        });

        await store.runs.recordBaseCheckpoint(run.run_id, "ckpt-3");

        const kwargs = await store.runs.getKwargs(run.run_id);
        expect(kwargs?.base_checkpoint_id).toBe("ckpt-3");
        // A targeted patch: the run's input must survive it, or a crash-recovered run would restart with
        // nothing to run on.
        expect(kwargs?.input).toEqual({ messages: ["hi"] });
        expect(kwargs?.stream_mode).toBe("values");
      });

      it("keeps 'recorded as no checkpoint' distinct from 'never recorded'", async () => {
        // The distinction a rollback turns on: null means revert the thread to empty, absent means leave
        // its checkpoints alone. Collapsing them would wipe history the run never wrote.
        const store = await makeStore();
        const thread_id = await seedThread(store);
        // Created with kwargs, as every run skein makes is — so this asserts the *key* is absent from a
        // real blob, not that the blob itself is missing.
        const untouched = await store.runs.create({
          thread_id,
          assistant_id: "a",
          kwargs: { input: {} },
        });
        expect(await store.runs.getKwargs(untouched.run_id)).not.toHaveProperty(
          "base_checkpoint_id",
        );

        await store.runs.setStatus(untouched.run_id, "success");
        const recorded = await store.runs.create({
          thread_id,
          assistant_id: "a",
          kwargs: { input: {} },
        });
        await store.runs.recordBaseCheckpoint(recorded.run_id, null);

        const kwargs = await store.runs.getKwargs(recorded.run_id);
        expect(kwargs).toHaveProperty("base_checkpoint_id");
        expect(kwargs?.base_checkpoint_id).toBeNull();
      });

      it("records a base checkpoint onto a run created with no kwargs at all", async () => {
        const store = await makeStore();
        const thread_id = await seedThread(store);
        const run = await store.runs.create({ thread_id, assistant_id: "a" });

        await store.runs.recordBaseCheckpoint(run.run_id, "ckpt-1");
        expect((await store.runs.getKwargs(run.run_id))?.base_checkpoint_id).toBe("ckpt-1");
      });

      it("ignores a base checkpoint recorded for an unknown run", async () => {
        // Best-effort bookkeeping: the run may have been deleted mid-start.
        const store = await makeStore();
        await expect(store.runs.recordBaseCheckpoint("ghost", "ckpt-1")).resolves.toBeUndefined();
      });

      it("round-trips a rollback plan through a run's kwargs", async () => {
        // Persisted so the instance executing a displacing run applies the plan, even when a different
        // instance created it.
        const store = await makeStore();
        const thread_id = await seedThread(store);
        const run = await store.runs.create({
          thread_id,
          assistant_id: "a",
          kwargs: {
            rollback_plan: {
              revert_to_checkpoint: { base_checkpoint_id: "ckpt-2" },
              displaced_run_ids: ["r-1", "r-2"],
            },
          },
        });

        expect((await store.runs.getKwargs(run.run_id))?.rollback_plan).toEqual({
          revert_to_checkpoint: { base_checkpoint_id: "ckpt-2" },
          displaced_run_ids: ["r-1", "r-2"],
        });
      });

      it("createIfThreadIdle creates on an idle thread and refuses on a busy one", async () => {
        const store = await makeStore();
        const thread_id = await seedThread(store);

        const first = await store.runs.createIfThreadIdle({ thread_id, assistant_id: "a" });
        expect(first).not.toBeNull();

        // The thread now has an inflight run, so the guard refuses rather than throwing — the service
        // turns the null into the 422 `multitask_strategy: "reject"` promises.
        expect(await store.runs.createIfThreadIdle({ thread_id, assistant_id: "a" })).toBeNull();

        // Once it settles the thread is idle again.
        await store.runs.setStatus(first!.run_id, "success");
        expect(
          await store.runs.createIfThreadIdle({ thread_id, assistant_id: "a" }),
        ).not.toBeNull();
      });

      it("createIfThreadIdle admits exactly one of many concurrent creates", async () => {
        // The race the method exists to close. Fired without awaiting in between, so the driver — not
        // the caller's ordering — is what decides. A check-then-create pair passes this in one process
        // and fails across two; a driver that serializes properly passes both.
        const store = await makeStore();
        const thread_id = await seedThread(store);

        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            store.runs.createIfThreadIdle({ thread_id, assistant_id: "a" }),
          ),
        );

        expect(results.filter((run) => run !== null)).toHaveLength(1);
        expect(await store.runs.listActiveRuns(thread_id)).toHaveLength(1);
      });

      it("createIfThreadIdle refuses when the thread does not exist", async () => {
        // Rather than inserting a run whose foreign key is about to fail anyway.
        const store = await makeStore();
        expect(
          await store.runs.createIfThreadIdle({ thread_id: "ghost", assistant_id: "a" }),
        ).toBeNull();
      });

      it("lists every thread's inflight runs when no thread is named", async () => {
        // The sweep behind `POST /runs/cancel` with only a status filter.
        const store = await makeStore();
        const first = await seedThread(store);
        const second = await seedThread(store);
        expect(await store.runs.listActiveRuns()).toEqual([]);

        const onFirst = await store.runs.create({ thread_id: first, assistant_id: "a" });
        const onSecond = await store.runs.create({ thread_id: second, assistant_id: "a" });
        await store.runs.setStatus(onSecond.run_id, "running");
        const done = await store.runs.create({ thread_id: second, assistant_id: "a" });
        await store.runs.setStatus(done.run_id, "success");

        expect((await store.runs.listActiveRuns()).map((run) => run.run_id).sort()).toEqual(
          [onFirst.run_id, onSecond.run_id].sort(),
        );
        // Naming a thread still narrows to it, so the two forms cannot drift.
        expect((await store.runs.listActiveRuns(first)).map((run) => run.run_id)).toEqual([
          onFirst.run_id,
        ]);
      });

      it("round-trips a run's opaque kwargs and returns null for an unknown run", async () => {
        const store = await makeStore();
        const thread_id = await seedThread(store);
        const run = await store.runs.create({
          thread_id,
          assistant_id: "a",
          // `checkpoint_id` (the time-travel fork target) rides the opaque kwargs blob — no dedicated
          // column/migration — so it must round-trip for a background/crash-recovered run to fork.
          kwargs: { input: { messages: ["hi"] }, stream_mode: "values", checkpoint_id: "ckpt-7" },
        });

        expect(await store.runs.getKwargs(run.run_id)).toEqual({
          input: { messages: ["hi"] },
          stream_mode: "values",
          checkpoint_id: "ckpt-7",
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

    describe("crons", () => {
      /** A cron due now, so a `listDue` scan picks it up without waiting for a clock. */
      const seedDueCron = async (
        store: SkeinStore,
        overrides: Partial<Parameters<SkeinStore["crons"]["create"]>[0]> = {},
      ) =>
        store.crons.create({
          assistant_id: "a",
          schedule: "*/5 * * * *",
          next_run_date: "2020-01-01T00:00:00.000Z",
          ...overrides,
        });

      it("creates a cron with the documented defaults", async () => {
        const store = await makeStore();
        const cron = await store.crons.create({ assistant_id: "a", schedule: "0 9 * * *" });

        expect(cron.cron_id).toBeTruthy();
        expect(cron.schedule).toBe("0 9 * * *");
        // Stateless by default, enabled by default, dormant until a next_run_date is computed.
        expect(cron.thread_id ?? null).toBeNull();
        expect(cron.enabled).toBe(true);
        expect(cron.next_run_date ?? null).toBeNull();
        expect(cron.timezone ?? null).toBeNull();
        expect(cron.payload).toEqual({});
        expect(cron.metadata).toEqual({});
      });

      it("round-trips every field, including a thread and an explicit id", async () => {
        const store = await makeStore();
        const { thread_id } = await store.threads.create();
        const created = await store.crons.create({
          cron_id: "fixed",
          assistant_id: "a",
          thread_id,
          schedule: "0 9 * * 1-5",
          timezone: "America/New_York",
          end_time: "2030-01-01T00:00:00.000Z",
          next_run_date: "2026-08-03T13:00:00.000Z",
          enabled: false,
          on_run_completed: "delete",
          payload: { input: { topic: "ai" } },
          metadata: { owner: "ada" },
          user_id: "ada",
        });

        const read = await store.crons.get("fixed");
        expect(read).toEqual(created);
        expect(read?.thread_id).toBe(thread_id);
        expect(read?.timezone).toBe("America/New_York");
        expect(read?.end_time).toBe("2030-01-01T00:00:00.000Z");
        expect(read?.next_run_date).toBe("2026-08-03T13:00:00.000Z");
        expect(read?.enabled).toBe(false);
        expect(read?.on_run_completed).toBe("delete");
        expect(read?.payload).toEqual({ input: { topic: "ai" } });
        expect(read?.user_id).toBe("ada");
      });

      // Both drivers must answer a duplicate id the same way — the Postgres one let a raw `pg`
      // unique-violation escape as a 500 while memory threw a typed 409.
      it("rejects a duplicate cron id as a conflict", async () => {
        const store = await makeStore();
        await store.crons.create({ cron_id: "fixed", assistant_id: "a", schedule: "* * * * *" });

        await expect(
          store.crons.create({ cron_id: "fixed", assistant_id: "a", schedule: "* * * * *" }),
        ).rejects.toMatchObject({ status: 409 });
      });

      // A capped batch must select the *same* crons on both drivers, which needs a tiebreak once
      // several share an occurrence — otherwise one driver can starve the same crons every tick.
      it("orders a due scan by cron_id when occurrences tie", async () => {
        const store = await makeStore();
        for (const cronId of ["c", "a", "b"]) {
          await seedDueCron(store, { cron_id: cronId });
        }

        const due = await store.crons.listDue({ dueAt: "2020-01-02T00:00:00.000Z", limit: 2 });
        expect(due.map((entry) => entry.cron.cron_id)).toEqual(["a", "b"]);
      });

      it("returns null for an unknown cron", async () => {
        const store = await makeStore();
        expect(await store.crons.get("nope")).toBeNull();
      });

      it("filters a search by assistant, thread, enabled, and metadata", async () => {
        const store = await makeStore();
        const { thread_id } = await store.threads.create();
        await store.crons.create({ assistant_id: "a", schedule: "* * * * *", thread_id });
        await store.crons.create({ assistant_id: "b", schedule: "* * * * *" });
        await store.crons.create({
          assistant_id: "b",
          schedule: "* * * * *",
          enabled: false,
          metadata: { owner: "ada", tier: "pro" },
        });

        expect((await store.crons.search({ assistant_id: "a" })).length).toBe(1);
        expect((await store.crons.search({ thread_id })).length).toBe(1);
        expect((await store.crons.search({ enabled: false })).length).toBe(1);
        expect((await store.crons.search({ enabled: true })).length).toBe(2);
        // Metadata matches on a *subset*, like Postgres' `@>`.
        expect((await store.crons.search({ metadata: { owner: "ada" } })).length).toBe(1);
        expect((await store.crons.search({ metadata: { owner: "nobody" } })).length).toBe(0);
      });

      it("sorts by each supported key, in both directions", async () => {
        const store = await makeStore();
        await store.crons.create({
          cron_id: "b",
          assistant_id: "a",
          schedule: "* * * * *",
          next_run_date: "2030-01-02T00:00:00.000Z",
        });
        await store.crons.create({
          cron_id: "a",
          assistant_id: "a",
          schedule: "* * * * *",
          next_run_date: "2030-01-01T00:00:00.000Z",
        });

        const ids = async (sortBy: "cron_id" | "next_run_date", sortOrder: "asc" | "desc") =>
          (await store.crons.search({ sortBy, sortOrder })).map((cron) => cron.cron_id);

        expect(await ids("cron_id", "asc")).toEqual(["a", "b"]);
        expect(await ids("cron_id", "desc")).toEqual(["b", "a"]);
        expect(await ids("next_run_date", "asc")).toEqual(["a", "b"]);
        expect(await ids("next_run_date", "desc")).toEqual(["b", "a"]);
      });

      // Postgres sorts NULLs first on DESC by default, which would put every dormant cron at the
      // top of "soonest next run". Both drivers pin them last in both directions instead.
      it("sorts a dormant cron last, in both directions", async () => {
        const store = await makeStore();
        await store.crons.create({ cron_id: "dormant", assistant_id: "a", schedule: "* * * * *" });
        await store.crons.create({
          cron_id: "armed",
          assistant_id: "a",
          schedule: "* * * * *",
          next_run_date: "2030-01-01T00:00:00.000Z",
        });

        for (const sortOrder of ["asc", "desc"] as const) {
          const found = await store.crons.search({ sortBy: "next_run_date", sortOrder });
          expect(found.map((cron) => cron.cron_id)).toEqual(["armed", "dormant"]);
        }
      });

      it("pages a search with limit and offset", async () => {
        const store = await makeStore();
        for (const cronId of ["a", "b", "c"]) {
          await store.crons.create({ cron_id: cronId, assistant_id: "a", schedule: "* * * * *" });
        }

        const page = await store.crons.search({ sortBy: "cron_id", sortOrder: "asc", limit: 2 });
        expect(page.map((cron) => cron.cron_id)).toEqual(["a", "b"]);
        const next = await store.crons.search({
          sortBy: "cron_id",
          sortOrder: "asc",
          limit: 2,
          offset: 2,
        });
        expect(next.map((cron) => cron.cron_id)).toEqual(["c"]);
      });

      it("counts every match, ignoring limit and offset", async () => {
        const store = await makeStore();
        for (const cronId of ["a", "b", "c"]) {
          await store.crons.create({ cron_id: cronId, assistant_id: "a", schedule: "* * * * *" });
        }

        expect(await store.crons.count({})).toBe(3);
        expect(await store.crons.count({ limit: 1, offset: 2 })).toBe(3);
        expect(await store.crons.count({ assistant_id: "nobody" })).toBe(0);
      });

      it("patches only the fields it is given", async () => {
        const store = await makeStore();
        const created = await store.crons.create({
          assistant_id: "a",
          schedule: "0 9 * * *",
          timezone: "UTC",
          payload: { input: { topic: "ai" } },
        });

        const patched = await store.crons.update(created.cron_id, { schedule: "0 10 * * *" });
        expect(patched.schedule).toBe("0 10 * * *");
        expect(patched.timezone).toBe("UTC");
        expect(patched.payload).toEqual({ input: { topic: "ai" } });
      });

      // The wire contract is explicit: on PATCH, send null to clear, omit to leave unchanged.
      // `COALESCE` alone cannot express that, which is why both drivers carry a "was it supplied" flag.
      it("treats end_time and timezone as tri-state on update", async () => {
        const store = await makeStore();
        const created = await store.crons.create({
          assistant_id: "a",
          schedule: "* * * * *",
          timezone: "America/New_York",
          end_time: "2030-01-01T00:00:00.000Z",
        });

        const untouched = await store.crons.update(created.cron_id, { schedule: "0 * * * *" });
        expect(untouched.timezone).toBe("America/New_York");
        expect(untouched.end_time).toBe("2030-01-01T00:00:00.000Z");

        const cleared = await store.crons.update(created.cron_id, {
          timezone: null,
          end_time: null,
        });
        expect(cleared.timezone ?? null).toBeNull();
        expect(cleared.end_time ?? null).toBeNull();
      });

      it("merges metadata on update rather than replacing it", async () => {
        const store = await makeStore();
        const created = await store.crons.create({
          assistant_id: "a",
          schedule: "* * * * *",
          metadata: { owner: "ada", tier: "pro" },
        });

        const patched = await store.crons.update(created.cron_id, { metadata: { tier: "free" } });
        expect(patched.metadata).toEqual({ owner: "ada", tier: "free" });
      });

      it("throws when updating an unknown cron", async () => {
        const store = await makeStore();
        await expect(store.crons.update("nope", { schedule: "* * * * *" })).rejects.toThrow();
      });

      it("deletes a cron", async () => {
        const store = await makeStore();
        const created = await store.crons.create({ assistant_id: "a", schedule: "* * * * *" });

        await store.crons.delete(created.cron_id);
        expect(await store.crons.get(created.cron_id)).toBeNull();
        // Idempotent, like every other delete in the contract.
        await store.crons.delete(created.cron_id);
      });

      it("lists only enabled, armed, due crons — soonest first", async () => {
        const store = await makeStore();
        await seedDueCron(store, { cron_id: "later", next_run_date: "2020-01-01T00:05:00.000Z" });
        await seedDueCron(store, { cron_id: "sooner", next_run_date: "2020-01-01T00:00:00.000Z" });
        await seedDueCron(store, { cron_id: "disabled", enabled: false });
        // Dormant: armed with no next_run_date at all.
        await store.crons.create({ cron_id: "dormant", assistant_id: "a", schedule: "* * * * *" });
        // Not yet due.
        await seedDueCron(store, { cron_id: "future", next_run_date: "2030-01-01T00:00:00.000Z" });

        const due = await store.crons.listDue({ dueAt: "2020-01-01T00:10:00.000Z" });
        expect(due.map((entry) => entry.cron.cron_id)).toEqual(["sooner", "later"]);
      });

      it("treats dueAt as inclusive", async () => {
        const store = await makeStore();
        await seedDueCron(store, { next_run_date: "2020-01-01T00:00:00.000Z" });

        expect((await store.crons.listDue({ dueAt: "2020-01-01T00:00:00.000Z" })).length).toBe(1);
      });

      it("bounds a due scan by its limit", async () => {
        const store = await makeStore();
        for (const cronId of ["a", "b", "c"]) await seedDueCron(store, { cron_id: cronId });

        expect(
          (await store.crons.listDue({ dueAt: "2020-01-02T00:00:00.000Z", limit: 2 })).length,
        ).toBe(2);
      });

      it("claims an occurrence, advancing next_run_date and creating the run together", async () => {
        const store = await makeStore();
        const { thread_id } = await store.threads.create();
        const cron = await seedDueCron(store, { thread_id });
        const [due] = await store.crons.listDue({ dueAt: "2020-01-02T00:00:00.000Z" });

        const claimed = await store.crons.claimAndCreateRun(
          cron.cron_id,
          { expectedSeq: due?.occurrenceSeq ?? 0, nextRunDate: "2030-01-01T00:00:00.000Z" },
          { thread_id, assistant_id: "a" },
        );

        expect(claimed?.cron.next_run_date).toBe("2030-01-01T00:00:00.000Z");
        expect(claimed?.run.status).toBe("pending");
        expect(claimed?.run.thread_id).toBe(thread_id);
        // Both writes landed: the advance is visible, and the run is readable.
        expect((await store.crons.get(cron.cron_id))?.next_run_date).toBe(
          "2030-01-01T00:00:00.000Z",
        );
        expect(await store.runs.get(claimed?.run.run_id ?? "")).not.toBeNull();
      });

      // The heart of the multi-instance story: two schedulers see the same due cron, and exactly
      // one fires it. Losing is not an error — it is the normal outcome for every other instance.
      it("lets only the holder of the current token claim an occurrence", async () => {
        const store = await makeStore();
        const { thread_id } = await store.threads.create();
        const cron = await seedDueCron(store, { thread_id });
        const [due] = await store.crons.listDue({ dueAt: "2020-01-02T00:00:00.000Z" });
        const claim = {
          expectedSeq: due?.occurrenceSeq ?? 0,
          nextRunDate: "2030-01-01T00:00:00.000Z",
        };

        const first = await store.crons.claimAndCreateRun(cron.cron_id, claim, {
          thread_id,
          assistant_id: "a",
        });
        const second = await store.crons.claimAndCreateRun(cron.cron_id, claim, {
          thread_id,
          assistant_id: "a",
        });

        expect(first).not.toBeNull();
        expect(second).toBeNull();
        // The loser created no run — that is what makes the occurrence fire exactly once.
        expect((await store.runs.listByThread(thread_id)).length).toBe(1);
      });

      it("rolls back the run when the claim loses", async () => {
        const store = await makeStore();
        const { thread_id } = await store.threads.create();
        const cron = await seedDueCron(store, { thread_id });

        const lost = await store.crons.claimAndCreateRun(
          cron.cron_id,
          { expectedSeq: 999, nextRunDate: "2030-01-01T00:00:00.000Z" },
          { thread_id, assistant_id: "a" },
        );

        expect(lost).toBeNull();
        expect(await store.runs.listByThread(thread_id)).toEqual([]);
      });

      it("refuses a claim on a cron disabled since the scan", async () => {
        const store = await makeStore();
        const { thread_id } = await store.threads.create();
        const cron = await seedDueCron(store, { thread_id });
        const [due] = await store.crons.listDue({ dueAt: "2020-01-02T00:00:00.000Z" });
        await store.crons.update(cron.cron_id, { enabled: false });

        const claimed = await store.crons.claimAndCreateRun(
          cron.cron_id,
          { expectedSeq: due?.occurrenceSeq ?? 0, nextRunDate: "2030-01-01T00:00:00.000Z" },
          { thread_id, assistant_id: "a" },
        );
        expect(claimed).toBeNull();
      });

      // A PATCH between the scan and the claim must invalidate the claim, so the scheduler never
      // fires against a payload the caller has just replaced.
      it("invalidates an in-flight claim when the cron is patched", async () => {
        const store = await makeStore();
        const { thread_id } = await store.threads.create();
        const cron = await seedDueCron(store, { thread_id });
        const [due] = await store.crons.listDue({ dueAt: "2020-01-02T00:00:00.000Z" });
        await store.crons.update(cron.cron_id, { payload: { input: { topic: "changed" } } });

        const claimed = await store.crons.claimAndCreateRun(
          cron.cron_id,
          { expectedSeq: due?.occurrenceSeq ?? 0, nextRunDate: "2030-01-01T00:00:00.000Z" },
          { thread_id, assistant_id: "a" },
        );
        expect(claimed).toBeNull();
      });

      it("advances an exhausted cron to dormant without creating a run", async () => {
        const store = await makeStore();
        const cron = await seedDueCron(store);
        const [due] = await store.crons.listDue({ dueAt: "2020-01-02T00:00:00.000Z" });

        const advanced = await store.crons.claimNextRun(cron.cron_id, {
          expectedSeq: due?.occurrenceSeq ?? 0,
          nextRunDate: null,
        });

        expect(advanced?.next_run_date ?? null).toBeNull();
        // Dormant drops straight out of the due scan.
        expect(await store.crons.listDue({ dueAt: "2030-01-01T00:00:00.000Z" })).toEqual([]);
      });

      it("returns null from claimNextRun for an unknown cron", async () => {
        const store = await makeStore();
        expect(
          await store.crons.claimNextRun("nope", { expectedSeq: 0, nextRunDate: null }),
        ).toBeNull();
      });

      it("round-trips the cron's principal, and keeps it off the wire row", async () => {
        const store = await makeStore();
        const user = {
          identity: "ada",
          display_name: "Ada",
          is_authenticated: true,
          permissions: ["runs:write"],
        };
        const cron = await store.crons.create({
          assistant_id: "a",
          schedule: "* * * * *",
          auth: { user, scopes: ["runs:write"] },
        });

        expect(await store.crons.getAuth(cron.cron_id)).toEqual({
          user,
          scopes: ["runs:write"],
        });
        // `payload` is echoed to any reader of the cron, so the principal must not ride along on it.
        expect(JSON.stringify(await store.crons.get(cron.cron_id))).not.toContain("runs:write");
      });

      it("returns null auth for a cron created without a principal", async () => {
        const store = await makeStore();
        const cron = await store.crons.create({ assistant_id: "a", schedule: "* * * * *" });

        expect(await store.crons.getAuth(cron.cron_id)).toBeNull();
        expect(await store.crons.getAuth("nope")).toBeNull();
      });

      it("reports how overdue the most overdue cron is", async () => {
        const store = await makeStore();
        await seedDueCron(store, { next_run_date: "2020-01-01T00:00:00.000Z" });
        await seedDueCron(store, { next_run_date: "2020-01-01T00:00:30.000Z" });
        // Neither of these counts: one is disabled, one is not due yet.
        await seedDueCron(store, { enabled: false });
        await seedDueCron(store, { next_run_date: "2030-01-01T00:00:00.000Z" });

        expect(await store.crons.maxOverdueMs("2020-01-01T00:01:00.000Z")).toBe(60_000);
      });

      it("reports no lag when nothing is due", async () => {
        const store = await makeStore();
        await seedDueCron(store, { next_run_date: "2030-01-01T00:00:00.000Z" });

        expect(await store.crons.maxOverdueMs("2020-01-01T00:00:00.000Z")).toBeNull();
      });

      // Designed out rather than handled: with the cron gone, "a thread cron whose thread was
      // deleted" is not a state the scheduler ever has to reason about.
      it("deletes a thread's crons along with the thread", async () => {
        const store = await makeStore();
        const { thread_id } = await store.threads.create();
        const threadCron = await store.crons.create({
          assistant_id: "a",
          schedule: "* * * * *",
          thread_id,
        });
        const stateless = await store.crons.create({ assistant_id: "a", schedule: "* * * * *" });

        await store.threads.delete(thread_id);

        expect(await store.crons.get(threadCron.cron_id)).toBeNull();
        // A stateless cron has no thread to be cascaded by.
        expect(await store.crons.get(stateless.cron_id)).not.toBeNull();
      });

      it("preserves sub-second precision on next_run_date", async () => {
        const store = await makeStore();
        // Not a cosmetic assertion: the scan reads this value and the wire returns it, so a driver
        // that rounds it would report a fire time it will not honour.
        const precise = "2030-01-01T00:00:00.123Z";
        const cron = await seedDueCron(store, { next_run_date: precise });

        expect((await store.crons.get(cron.cron_id))?.next_run_date).toBe(precise);
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

      it("pages distinct namespaces", async () => {
        const store = await makeStore();
        await store.store.put(["users", "1"], "a", {});
        await store.store.put(["users", "2"], "b", {});
        await store.store.put(["users", "3"], "c", {});

        await expect(
          store.store.listNamespaces(["users"], { offset: 1, limit: 1 }),
        ).resolves.toEqual([["users", "2"]]);
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

    // The server's own metadata scoping, AND-ed with the caller's filter. Both drivers must apply it
    // with the same containment semantics as `metadata`, because the auth ownership filter is pushed
    // into it — a driver that ignored it would return other tenants' rows for the JS filter to catch,
    // and one that matched it differently would hide rows a caller owns.
    describe("driver parity — enforcedMetadata", () => {
      it("restricts results the same way a metadata filter does", async () => {
        const store = await makeStore();
        await store.threads.create({ metadata: { owner: "alice" } });
        await store.threads.create({ metadata: { owner: "bob" } });

        const alices = await store.threads.search({ enforcedMetadata: { owner: "alice" } });
        expect(alices.length).toBe(1);
        expect(alices[0]?.metadata?.["owner"]).toBe("alice");
      });

      it("is AND-ed with the caller's metadata filter, not merged with it", async () => {
        const store = await makeStore();
        await store.threads.create({ metadata: { owner: "alice", topic: "x" } });
        await store.threads.create({ metadata: { owner: "bob", topic: "x" } });

        // Same key, different values: the correct answer is nothing at all. A merge would answer with
        // whichever side won, handing one tenant the other's row.
        expect(
          await store.threads.search({
            metadata: { owner: "bob" },
            enforcedMetadata: { owner: "alice" },
          }),
        ).toEqual([]);
        // Different keys: both apply.
        expect(
          (
            await store.threads.search({
              metadata: { topic: "x" },
              enforcedMetadata: { owner: "alice" },
            })
          ).length,
        ).toBe(1);
      });

      it("matches an array clause by containment, the way $contains needs", async () => {
        const store = await makeStore();
        await store.threads.create({ metadata: { tags: ["red", "blue"] } });
        await store.threads.create({ metadata: { tags: ["blue"] } });
        await store.threads.create({ metadata: { tags: "red" } });

        expect((await store.threads.search({ enforcedMetadata: { tags: ["red"] } })).length).toBe(
          1,
        );
        expect(
          (await store.threads.search({ enforcedMetadata: { tags: ["red", "blue"] } })).length,
        ).toBe(1);
        expect((await store.threads.search({ enforcedMetadata: { tags: ["green"] } })).length).toBe(
          0,
        );
      });

      it("excludes a thread with no metadata at all", async () => {
        const store = await makeStore();
        await store.threads.create();

        expect(await store.threads.search({ enforcedMetadata: { owner: "alice" } })).toEqual([]);
      });

      it("pages the restricted set, not the whole table", async () => {
        const store = await makeStore();
        for (const owner of ["alice", "bob", "alice", "bob", "alice"]) {
          await store.threads.create({ metadata: { owner } });
        }

        const page = await store.threads.search({
          enforcedMetadata: { owner: "alice" },
          limit: 2,
        });
        const next = await store.threads.search({
          enforcedMetadata: { owner: "alice" },
          limit: 2,
          offset: 2,
        });
        expect(page.length).toBe(2);
        expect(next.length).toBe(1);
        expect([...page, ...next].every((thread) => thread.metadata?.["owner"] === "alice")).toBe(
          true,
        );
      });
    });

    // Every list/search path is bounded, including when the caller passes no `limit` at all — that is
    // what stops one request materializing a whole table. The bound is a driver concern (the memory
    // driver slices, Postgres emits `LIMIT`), so it belongs here rather than in either driver's tests.
    describe("driver parity — page bound", () => {
      /** Five threads, oldest first. `created_at` ordering is what the paging assertions rely on. */
      async function seedThreads(store: SkeinStore): Promise<void> {
        for (const index of [0, 1, 2, 3, 4]) {
          await store.threads.create({ metadata: { index } });
        }
      }

      // Asserts *which* rows, not just how many: a truncated page is only interchangeable across
      // drivers if they order it the same way. Insertion order and `ORDER BY created_at, <id>` agree on
      // freshly-created rows but diverge after a snapshot restore, so pin the ordering.
      //
      // Timestamps are forced apart because a *tie* cannot be asserted across drivers: Postgres stores
      // `created_at` at microsecond resolution but exposes it on the wire at millisecond resolution, so
      // rows that look tied here are strictly ordered there. Ties are a within-driver determinism
      // concern, which the id tiebreaker handles; they are not a parity contract.
      it("bounds threads.list to the oldest rows, ordered the same on every driver", async () => {
        const store = await makeStore({ maxPageSize: 2 });
        const created: Thread[] = [];
        for (const index of [0, 1, 2, 3, 4]) {
          created.push(await store.threads.create({ metadata: { index } }));
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        const expected = [...created]
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .slice(0, 2)
          .map((thread) => thread.thread_id);

        expect((await store.threads.list()).map((thread) => thread.thread_id)).toEqual(expected);
      });

      it("bounds threads.search when no limit is given", async () => {
        const store = await makeStore({ maxPageSize: 2 });
        await seedThreads(store);

        expect((await store.threads.search({})).length).toBe(2);
      });

      it("bounds a limit larger than the page bound rather than honouring it", async () => {
        const store = await makeStore({ maxPageSize: 2 });
        await seedThreads(store);

        expect((await store.threads.search({ limit: 100 })).length).toBe(2);
      });

      it("honours a limit below the page bound, and still pages with an offset", async () => {
        const store = await makeStore({ maxPageSize: 2 });
        await seedThreads(store);

        const first = await store.threads.search({ limit: 1 });
        const second = await store.threads.search({ limit: 1, offset: 1 });
        expect(first.length).toBe(1);
        expect(second.length).toBe(1);
        expect(second[0]?.thread_id).not.toBe(first[0]?.thread_id);
      });

      it("bounds assistants.search but not assistants.count", async () => {
        const store = await makeStore({ maxPageSize: 2 });
        for (const index of [0, 1, 2, 3, 4]) {
          await store.assistants.create({ graph_id: "agent", name: `a${index}` });
        }

        // `count` answers "how many match" — bounding it would make it report the page size instead of
        // the total, which is the one number that says a page was truncated.
        expect((await store.assistants.search({})).length).toBe(2);
        expect(await store.assistants.count({})).toBe(5);
      });

      it("publishes the page bound it actually applies", async () => {
        // A caller that reads an unbounded collection needs to tell a complete result from a truncated
        // one — `POST /runs/cancel` reports `truncated` from exactly this. Reporting a bound the driver
        // does not apply would be worse than reporting none, so it is asserted against real behaviour.
        const store = await makeStore({ maxPageSize: 2 });
        expect(store.maxPageSize).toBe(2);

        for (const index of [0, 1, 2, 3, 4]) await store.threads.create({ metadata: { index } });
        expect((await store.threads.search({})).length).toBe(store.maxPageSize);
      });

      it("bounds threads.search but not threads.count", async () => {
        const store = await makeStore({ maxPageSize: 2 });
        for (const index of [0, 1, 2, 3, 4]) {
          await store.threads.create({ metadata: { index } });
        }

        // Same contract as assistants: a count measured through `search` would report the page size,
        // which is exactly the number that cannot tell a caller their page was truncated.
        expect((await store.threads.search({})).length).toBe(2);
        expect(await store.threads.count({})).toBe(5);
      });

      it("bounds store.search when no limit is given", async () => {
        const store = await makeStore({ maxPageSize: 2 });
        for (const index of [0, 1, 2, 3, 4]) {
          await store.store.put(["ns"], `k${index}`, { index });
        }

        expect((await store.store.search({ prefix: ["ns"] })).length).toBe(2);
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
