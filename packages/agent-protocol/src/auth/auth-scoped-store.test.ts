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
