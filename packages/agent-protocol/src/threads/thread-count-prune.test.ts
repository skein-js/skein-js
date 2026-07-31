// `POST /threads/count` and `POST /threads/prune` — the rest of the SDK's threads surface.

import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import {
  createProtocolHandlers,
  type ProtocolRequest,
  type ProtocolResponse,
} from "../create-handlers.js";
import { createProtocolServiceFromContext } from "../service.js";

async function harness(deps = createFixtureDeps()) {
  const ctx = createContext(deps);
  const service = createProtocolServiceFromContext(ctx);
  await service.assistants.registerGraphAssistants();
  return { ctx, deps, service, handlers: createProtocolHandlers(service) };
}

function request(body: unknown = {}): ProtocolRequest {
  return { method: "post", url: "http://localhost/", params: {}, query: {}, body, headers: {} };
}

/** The JSON body of a handler response. Narrowed here so each assertion reads as the value, not a cast. */
const bodyOf = <T>(response: ProtocolResponse): T => {
  if (response.kind !== "json") throw new Error(`expected a json response, got "${response.kind}"`);
  return response.body as T;
};

describe("POST /threads/count", () => {
  it("counts every thread, and narrows by metadata and status", async () => {
    const { deps, service, handlers } = await harness();
    const busy = await service.threads.create({ metadata: { graph_id: "chat" } });
    await service.threads.create({ metadata: { graph_id: "chat" } });
    await service.threads.create({ metadata: { graph_id: "research" } });

    expect(bodyOf(await handlers.countThreads(request({})))).toBe(3);
    expect(bodyOf(await handlers.countThreads(request({ metadata: { graph_id: "chat" } })))).toBe(
      2,
    );

    // Status too, so a dashboard can count what is running without listing it. Set on the row
    // directly: a *pending* background run leaves the thread idle — the engine mirrors it to busy only
    // once the run starts executing.
    await deps.store.threads.update(busy.thread_id, { status: "busy" });
    expect(bodyOf(await handlers.countThreads(request({ status: "busy" })))).toBe(1);
  });

  it("counts past the page bound that search stops at", async () => {
    // The point of a count endpoint: `search` answers with a page, so it can never report a total
    // larger than one.
    const { service, handlers } = await harness();
    for (let index = 0; index < 5; index += 1) await service.threads.create();

    expect(bodyOf(await handlers.countThreads(request({})))).toBe(5);
    expect((await service.threads.search({ limit: 2 })).length).toBe(2);
  });
});

describe("POST /threads/prune", () => {
  it("deletes the named threads and reports how many it removed", async () => {
    const { deps, service, handlers } = await harness();
    const doomed = await service.threads.create();
    const alsoDoomed = await service.threads.create();
    const spared = await service.threads.create();

    const response = await handlers.pruneThreads(
      request({ thread_ids: [doomed.thread_id, alsoDoomed.thread_id] }),
    );

    expect(bodyOf<{ pruned_count: number }>(response).pruned_count).toBe(2);
    expect(await deps.store.threads.get(doomed.thread_id)).toBeNull();
    expect(await deps.store.threads.get(alsoDoomed.thread_id)).toBeNull();
    expect(await deps.store.threads.get(spared.thread_id)).not.toBeNull();
  });

  it("skips an unknown id instead of failing the batch or counting it", async () => {
    // A prune names a set; one absent member does not invalidate the rest. Skipping rather than 404ing
    // also keeps the count from telling a caller whether someone else's thread exists.
    const { service, handlers } = await harness();
    const real = await service.threads.create();

    const response = await handlers.pruneThreads(
      request({ thread_ids: [real.thread_id, "ghost"] }),
    );

    expect(bodyOf<{ pruned_count: number }>(response).pruned_count).toBe(1);
  });

  it("counts a repeated id once", async () => {
    const { service, handlers } = await harness();
    const thread = await service.threads.create();

    const response = await handlers.pruneThreads(
      request({ thread_ids: [thread.thread_id, thread.thread_id] }),
    );

    expect(bodyOf<{ pruned_count: number }>(response).pruned_count).toBe(1);
  });

  it("keep_latest trims the history but keeps the thread and its current state", async () => {
    const { deps, service, handlers } = await harness();
    const thread = await service.threads.create();
    for (const value of ["one", "two", "three"]) {
      await service.runs.createWait({
        thread_id: thread.thread_id,
        assistant_id: "echo",
        input: { value },
      });
    }
    const before = await service.threads.history(thread.thread_id);
    expect(before.length).toBeGreaterThan(1);
    const tip = before[0];

    const response = await handlers.pruneThreads(
      request({ thread_ids: [thread.thread_id], strategy: "keep_latest" }),
    );

    expect(bodyOf<{ pruned_count: number }>(response).pruned_count).toBe(1);
    expect(await deps.store.threads.get(thread.thread_id)).not.toBeNull();

    const after = await service.threads.history(thread.thread_id);
    expect(after.length).toBe(1);
    // The surviving checkpoint is the same state the thread was on, and it is now a root: its parent
    // link was cleared, so nothing points at a checkpoint that no longer exists.
    expect(after[0]?.values).toEqual(tip?.values);
    expect(after[0]?.parent_checkpoint).toBeNull();
    // …and the thread still reads and resumes normally through the ordinary state path.
    expect((await service.threads.getState(thread.thread_id)).values).toEqual(tip?.values);
  });

  it("keep_latest leaves a thread with nothing to prune untouched, and does not count it", async () => {
    // A thread that has never run has no checkpoints at all. The delete-and-replay is skipped
    // entirely rather than run against an empty history, and the thread survives either way.
    const { deps, service, handlers } = await harness();
    const thread = await service.threads.create();

    const response = await handlers.pruneThreads(
      request({ thread_ids: [thread.thread_id], strategy: "keep_latest" }),
    );

    expect(bodyOf<{ pruned_count: number }>(response).pruned_count).toBe(0);
    expect(await deps.store.threads.get(thread.thread_id)).not.toBeNull();
    expect(await service.threads.history(thread.thread_id)).toEqual([]);
  });

  it("409s a keep_latest prune of a busy thread rather than racing its writes", async () => {
    const { service, handlers } = await harness();
    const thread = await service.threads.create();
    await service.runs.createBackground(thread.thread_id, { assistant_id: "echo" });

    await expect(
      handlers.pruneThreads(request({ thread_ids: [thread.thread_id], strategy: "keep_latest" })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects an empty or oversized thread_ids list", async () => {
    const { handlers } = await harness();

    await expect(handlers.pruneThreads(request({ thread_ids: [] }))).rejects.toMatchObject({
      status: 400,
    });
    const tooMany = Array.from({ length: 1001 }, (_unused, index) => `t${index}`);
    await expect(handlers.pruneThreads(request({ thread_ids: tooMany }))).rejects.toMatchObject({
      status: 400,
    });
  });
});
