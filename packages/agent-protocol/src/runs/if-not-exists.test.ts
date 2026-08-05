// `if_not_exists` on run create — LangGraph's "create the thread if it isn't there" knob.
//
// The point of these tests is that the three thread-scoped create routes **agree**. They used not to:
// `/threads/{id}/runs/wait` and `.../stream` fold the path id into the body and went through a
// get-or-create, so an unknown thread was silently created; `/threads/{id}/runs` required the thread
// and 404d. Nothing covered either behaviour, which is how they drifted apart.

import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { createProtocolServiceFromContext } from "../service.js";

async function harness(deps = createFixtureDeps()) {
  const service = createProtocolServiceFromContext(createContext(deps));
  await service.assistants.registerGraphAssistants();
  return { deps, service };
}

const run = { assistant_id: "echo", input: { value: "hi" } } as const;

describe("if_not_exists on run create", () => {
  describe("defaults to reject — an unknown thread is a 404, not a fresh empty one", () => {
    it("on POST /threads/{id}/runs/wait", async () => {
      const { deps, service } = await harness();

      await expect(service.runs.createWait({ ...run, thread_id: "ghost" })).rejects.toMatchObject({
        status: 404,
      });
      expect(await deps.store.threads.get("ghost")).toBeNull();
    });

    it("on POST /threads/{id}/runs/stream", async () => {
      const { deps, service } = await harness();

      await expect(service.runs.createStream({ ...run, thread_id: "ghost" })).rejects.toMatchObject(
        {
          status: 404,
        },
      );
      expect(await deps.store.threads.get("ghost")).toBeNull();
    });

    it("on POST /threads/{id}/runs", async () => {
      const { deps, service } = await harness();

      await expect(service.runs.createBackground("ghost", run)).rejects.toMatchObject({
        status: 404,
      });
      expect(await deps.store.threads.get("ghost")).toBeNull();
    });
  });

  describe('if_not_exists: "create" brings the thread into existence', () => {
    it("on POST /threads/{id}/runs/wait", async () => {
      const { deps, service } = await harness();

      const { threadId } = await service.runs.createWait({
        ...run,
        thread_id: "fresh",
        if_not_exists: "create",
      });

      expect(threadId).toBe("fresh");
      expect(await deps.store.threads.get("fresh")).not.toBeNull();
    });

    it("on POST /threads/{id}/runs", async () => {
      const { deps, service } = await harness();

      const created = await service.runs.createBackground("fresh", {
        ...run,
        if_not_exists: "create",
      });

      expect(created.thread_id).toBe("fresh");
      expect(await deps.store.threads.get("fresh")).not.toBeNull();
    });

    it("reuses the thread when it already exists, rather than replacing it", async () => {
      const { deps, service } = await harness();
      const existing = await service.threads.create({
        thread_id: "known",
        metadata: { keep: "me" },
      });

      await service.runs.createWait({ ...run, thread_id: "known", if_not_exists: "create" });

      const after = await deps.store.threads.get("known");
      expect(after?.created_at).toBe(existing.created_at);
      expect(after?.metadata).toMatchObject({ keep: "me" });
    });
  });

  it("does not hand a caller-named thread to on_completion: delete", async () => {
    // `ownsThread` is "the caller named no thread", not "we happened to create one". A thread this run
    // brought into existence under `if_not_exists: "create"` is still the caller's — deleting it would
    // destroy a thread they addressed by a stable external key and expect to find again.
    const { deps, service } = await harness();

    await service.runs.createWait({
      ...run,
      thread_id: "caller-owned",
      if_not_exists: "create",
      on_completion: "delete",
    });

    expect(await deps.store.threads.get("caller-owned")).not.toBeNull();
  });

  it("is inert on the stateless routes, which own their thread either way", async () => {
    const { deps, service } = await harness();

    // A body `thread_id` is stripped by `POST /runs`, so `if_not_exists` has nothing to act on and the
    // server still mints its own thread rather than 404ing on the named one.
    const created = await service.runs.createStatelessBackground({
      ...run,
      thread_id: "ignored",
      if_not_exists: "reject",
    });

    expect(created.thread_id).not.toBe("ignored");
    expect(await deps.store.threads.get(created.thread_id)).not.toBeNull();
  });
});
