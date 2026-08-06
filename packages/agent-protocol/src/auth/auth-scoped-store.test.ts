// The ownership-scoping wrapper must forward every argument it doesn't itself act on. It is easy to
// re-implement a method's signature from memory and drop a trailing optional parameter — which
// compiles cleanly, and then silently loses data on every auth-enabled deployment only.

import type { AuthEngine, AuthFilters, Metadata } from "@skein-js/core";
import { MemorySkeinStore } from "@skein-js/storage-memory";
import { describe, expect, it } from "vitest";

import { createAuthScopedStore } from "./auth-scoped-store.js";

/** A minimal engine that scopes by an `owner` metadata key. */
const ownerEngine = {
  enabled: true,
  studioAuthDisabled: false,
  authenticate: async () => {
    throw new Error("unused");
  },
  authorize: async () => undefined,
  matchesFilters: (metadata: Metadata | undefined, filters: AuthFilters) =>
    metadata?.["owner"] === (filters as { owner?: unknown }).owner,
  stampFromFilters: (metadata: Metadata | undefined, filters: AuthFilters) => ({
    ...metadata,
    owner: (filters as { owner?: unknown }).owner,
  }),
} as unknown as AuthEngine;

async function scopedRuns() {
  const inner = new MemorySkeinStore();
  const scoped = createAuthScopedStore(inner, ownerEngine, { owner: "alice" }, "threads");
  const thread = await inner.threads.create({ metadata: { owner: "alice" } });
  const run = await scoped.runs.create({
    thread_id: thread.thread_id,
    assistant_id: "a",
  });
  return { inner, scoped, run };
}

describe("createAuthScopedStore", () => {
  // Which run reads are ownership-filtered and which are deliberately not is a boundary, and a perf pass
  // already crossed it once (`joinStream` was moved off the filtered `listByThread` onto `listActiveRuns`
  // + `latestForThread`). These pin the boundary from both sides so the next such move is deliberate.
  // Note what the filtered side is and is not for: `runs.get` is the gate every run hand-back funnels
  // through, so the exemptions below cannot leak a run — they can only make a *selection* disagree with
  // that gate. See `thread-stream-service.test.ts` for the behaviour that falls out of getting it wrong.
  describe("run reads on a thread the caller owns, carrying a run they do not own", () => {
    /** An owned thread whose only run belongs to someone else — the shape an upgrade can leave behind. */
    async function threadWithForeignRun() {
      const inner = new MemorySkeinStore();
      const scoped = createAuthScopedStore(inner, ownerEngine, { owner: "alice" }, "threads");
      const thread = await inner.threads.create({ metadata: { owner: "alice" } });
      // Created on the *inner* store, so it carries no `owner: alice` stamp.
      const foreign = await inner.runs.create({
        thread_id: thread.thread_id,
        assistant_id: "a",
        metadata: { owner: "bob" },
      });
      return { inner, scoped, thread, foreign };
    }

    it("hides it from listByThread — the read joinStream must select through", async () => {
      const { scoped, thread } = await threadWithForeignRun();

      expect(await scoped.runs.listByThread(thread.thread_id)).toEqual([]);
    });

    it("hides it from runs.get, so streaming it would contradict reading it", async () => {
      const { scoped, foreign } = await threadWithForeignRun();

      expect(await scoped.runs.get(foreign.run_id)).toBeNull();
    });

    // The other side of the boundary, asserted so the exemptions are not "fixed" into filters later:
    // both exist to serve the server, not the caller. `listActiveRuns` is the per-thread concurrency
    // guard — filtering it would hide another principal's inflight run and let two runs interleave
    // checkpoint writes on one thread. `latestForThread` resolves graph identity, and filtering it would
    // make every state read on a thread whose latest run came from a cron come back empty.
    it("still exposes it to listActiveRuns and latestForThread, which are server machinery", async () => {
      const { scoped, thread, foreign } = await threadWithForeignRun();

      expect((await scoped.runs.listActiveRuns(thread.thread_id)).map((run) => run.run_id)).toEqual(
        [foreign.run_id],
      );
      expect((await scoped.runs.latestForThread(thread.thread_id))?.run_id).toBe(foreign.run_id);
    });
  });

  it("forwards a run's failure reason through setStatus", async () => {
    const { inner, scoped, run } = await scopedRuns();
    const failure = {
      error: "TypeError",
      name: "TypeError",
      message: "boom",
      cause: { error: "Error", name: "Error", message: "root" },
    };

    const returned = await scoped.runs.setStatus(run.run_id, "error", failure);

    expect(returned.error).toEqual(failure);
    // Read through the *inner* store: the wrapper must have written it, not just echoed it back.
    expect((await inner.runs.get(run.run_id))?.error).toEqual(failure);
  });

  // The store bounds every search to a page (docs/storage.md). With the ownership filter pushed into the
  // query the page is a page of the *caller's* rows, so this works with one query; before the pushdown
  // it needed a paged drain, and before that it returned nothing at all.
  it("finds the caller's threads past the driver's page bound", async () => {
    const inner = new MemorySkeinStore({ maxPageSize: 3 });
    const scoped = createAuthScopedStore(inner, ownerEngine, { owner: "alice" }, "threads");
    // Alice's three are the *oldest*, and search defaults to created_at DESC, so they fall outside the
    // first page of three entirely.
    for (const owner of ["alice", "alice", "alice", "bob", "bob", "bob"]) {
      await inner.threads.create({ metadata: { owner } });
    }

    const found = await scoped.threads.search({});

    expect(found.length).toBe(3);
    expect(found.every((thread) => thread.metadata?.["owner"] === "alice")).toBe(true);
  });

  it("pages the caller's own threads with limit/offset, not the driver's rows", async () => {
    const inner = new MemorySkeinStore({ maxPageSize: 3 });
    const scoped = createAuthScopedStore(inner, ownerEngine, { owner: "alice" }, "threads");
    for (const owner of ["alice", "alice", "alice", "bob", "bob", "bob"]) {
      await inner.threads.create({ metadata: { owner } });
    }

    const first = await scoped.threads.search({ limit: 2 });
    const second = await scoped.threads.search({ limit: 2, offset: 2 });

    expect(first.length).toBe(2);
    expect(second.length).toBe(1);
    expect(new Set([...first, ...second].map((thread) => thread.thread_id)).size).toBe(3);
  });

  // `threadSearchSchema` passes unknown fields through, so a request body can carry `enforcedMetadata`
  // as far as this decorator. It must be overwritten, not merged or honoured.
  it("ignores an enforcedMetadata supplied by the caller", async () => {
    const inner = new MemorySkeinStore();
    const scoped = createAuthScopedStore(inner, ownerEngine, { owner: "alice" }, "threads");
    await inner.threads.create({ metadata: { owner: "alice" } });
    await inner.threads.create({ metadata: { owner: "bob" } });

    const found = await scoped.threads.search({
      enforcedMetadata: { owner: "bob" },
    } as Parameters<typeof scoped.threads.search>[0]);

    expect(found.length).toBe(1);
    expect(found[0]?.metadata?.["owner"]).toBe("alice");
  });

  // The scoped `list` has to go through `search` for the same reason: it takes no filter of its own, so
  // filtering its page afterwards hides rows past the page bound.
  it("scopes list to the caller's own threads, past the page bound", async () => {
    const inner = new MemorySkeinStore({ maxPageSize: 3 });
    const scoped = createAuthScopedStore(inner, ownerEngine, { owner: "alice" }, "threads");
    // Alice's are the newest here, so an ascending `list` page of three would hold only bob's.
    for (const owner of ["bob", "bob", "bob", "alice", "alice"]) {
      await inner.threads.create({ metadata: { owner } });
    }

    const listed = await scoped.threads.list();

    expect(listed.length).toBe(2);
    expect(listed.every((thread) => thread.metadata?.["owner"] === "alice")).toBe(true);
  });

  // The pushdown deliberately errs broad: a filter clause it cannot express exactly is left out, so the
  // in-process filter is what actually enforces ownership. Proven with an engine whose `matchesFilters`
  // is stricter than anything the translation can express.
  it("still filters in process when the pushdown cannot express the filter", async () => {
    const oddOwnerEngine = {
      ...ownerEngine,
      matchesFilters: (metadata: Metadata | undefined) =>
        typeof metadata?.["owner"] === "string" && metadata["owner"].startsWith("a"),
    } as unknown as AuthEngine;
    const inner = new MemorySkeinStore();
    // `{}` translates to no clause at all, so every row reaches the in-process filter.
    const scoped = createAuthScopedStore(inner, oddOwnerEngine, { owner: {} }, "threads");
    await inner.threads.create({ metadata: { owner: "alice" } });
    await inner.threads.create({ metadata: { owner: "bob" } });

    const found = await scoped.threads.search({});

    expect(found.length).toBe(1);
    expect(found[0]?.metadata?.["owner"]).toBe("alice");
  });

  it("still hides a run the caller does not own", async () => {
    const inner = new MemorySkeinStore();
    const scoped = createAuthScopedStore(inner, ownerEngine, { owner: "bob" }, "threads");
    const thread = await inner.threads.create({ metadata: { owner: "alice" } });
    const run = await inner.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "a",
      metadata: { owner: "alice" },
    });

    await expect(scoped.runs.setStatus(run.run_id, "error")).rejects.toMatchObject({ status: 404 });
  });
});
