import type { AuthEngine, AuthFilters, Metadata } from "@skein-js/core";
import { MemorySkeinStore } from "@skein-js/storage-memory";
import { describe, expect, it } from "vitest";

import { collect, createFixtureDeps } from "../__fixtures__/deps.js";
import { createAuthScopedStore } from "../auth/auth-scoped-store.js";
import { createContext } from "../context.js";
import { createProtocolServiceFromContext } from "../service.js";

async function serviceWithAssistants(deps = createFixtureDeps()) {
  const service = createProtocolServiceFromContext(createContext(deps));
  await service.assistants.registerGraphAssistants();
  return service;
}

/** A minimal engine that scopes by an `owner` metadata key, as in `auth-scoped-store.test.ts`. */
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

describe("thread stream service — interrupt / resume", () => {
  it("streams a run, interrupts, then resumes with a command back to idle", async () => {
    const service = await serviceWithAssistants();
    const thread = await service.threads.create();

    const started = await service.threadStream.stream(thread.thread_id, {
      assistant_id: "interrupting",
      input: {},
    });
    await collect(started.frames);

    expect((await service.threads.get(thread.thread_id)).status).toBe("interrupted");

    const resumed = await service.threadStream.command(thread.thread_id, { resume: "yes" });
    await collect(resumed.frames);

    const thread2 = await service.threads.get(thread.thread_id);
    expect(thread2.status).toBe("idle");
    expect(thread2.values).toEqual({ value: "resumed: yes" });
  });

  it("409s a command on a thread that is not interrupted", async () => {
    const service = await serviceWithAssistants();
    const thread = await service.threads.create();
    await expect(
      service.threadStream.command(thread.thread_id, { resume: "x" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  // `latestRunAssistant` reads `assistant_id` off the thread's metadata, where `stampGraphOnThread`
  // puts it — but that stamp is best-effort and absent on threads created before it existed, so the
  // fallback to the thread's latest run has to work. Reproduced by clearing the stamp (metadata
  // replaces on update) and resuming with no explicit `assistant_id`.
  it("resumes from the latest run when the thread carries no assistant_id stamp", async () => {
    const deps = createFixtureDeps();
    const service = await serviceWithAssistants(deps);
    const thread = await service.threads.create();
    const started = await service.threadStream.stream(thread.thread_id, {
      assistant_id: "interrupting",
      input: {},
    });
    await collect(started.frames);

    const stamped = await service.threads.get(thread.thread_id);
    expect(stamped.metadata?.["assistant_id"]).toBe("interrupting");
    // Keep `graph_id` (the state read needs it) but drop the assistant stamp. Straight on the store,
    // since `ThreadUpdate.metadata` replaces and the service has no metadata-only patch.
    await deps.store.threads.update(thread.thread_id, {
      metadata: { graph_id: stamped.metadata?.["graph_id"] },
    });

    const resumed = await service.threadStream.command(thread.thread_id, { resume: "yes" });
    await collect(resumed.frames);
    expect((await service.threads.get(thread.thread_id)).values).toEqual({
      value: "resumed: yes",
    });
  });

  // Two inflight runs on one thread is legal (the `enqueue` strategy produces it), and the join has to
  // pick deterministically. Created straight on the store so both stay `pending`.
  it("joins the newest inflight run when a thread has more than one", async () => {
    const deps = createFixtureDeps();
    const service = await serviceWithAssistants(deps);
    const thread = await service.threads.create();

    const older = await deps.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "echo",
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newer = await deps.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "echo",
    });

    const joined = await service.threadStream.joinStream(thread.thread_id, 0);
    expect(joined.runId).toBe(newer.run_id);
    expect(joined.runId).not.toBe(older.run_id);
  });

  // `joinStream` must select its target from the same ownership-filtered read the join will accept
  // (`runs.join` re-reads through the filtered `runs.get`). Selecting from an unfiltered read is not a
  // leak — the join still refuses a foreign run — it *denies a legitimate join*: the caller's own
  // joinable run is passed over because another principal's run on the same thread is newer, and they
  // get a 404. A perf pass moved this onto `listActiveRuns`/`latestForThread` and this is what catches it.
  it("joins the caller's own run even when a newer run on the thread is another principal's", async () => {
    const inner = new MemorySkeinStore();
    const deps = createFixtureDeps({
      store: createAuthScopedStore(inner, ownerEngine, { owner: "alice" }, "threads"),
    });
    const service = await serviceWithAssistants(deps);

    const thread = await inner.threads.create({ metadata: { owner: "alice" } });
    const mine = await inner.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      metadata: { owner: "alice" },
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    // Newer, and not alice's — the shape enabling auth on an existing deployment can leave behind (a
    // thread is re-stamped on its next update; old run rows are not).
    await inner.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      metadata: { owner: "bob" },
    });

    const joined = await service.threadStream.joinStream(thread.thread_id, 0);
    expect(joined.runId).toBe(mine.run_id);
  });

  it("joins the current run's stream on an existing thread", async () => {
    const service = await serviceWithAssistants();
    const thread = await service.threads.create();
    const started = await service.threadStream.stream(thread.thread_id, {
      assistant_id: "echo",
      input: { value: "hi" },
    });
    await collect(started.frames);

    const joined = await service.threadStream.joinStream(thread.thread_id, 0);
    expect(joined.runId).toBe(started.runId);
    expect((await collect(joined.frames)).length).toBeGreaterThan(0);
  });
});
