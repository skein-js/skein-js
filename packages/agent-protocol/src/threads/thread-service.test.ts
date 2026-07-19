import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { createProtocolServiceFromContext } from "../service.js";

async function serviceWithAssistants(deps = createFixtureDeps()) {
  const service = createProtocolServiceFromContext(createContext(deps));
  await service.assistants.registerGraphAssistants();
  return service;
}

describe("thread service", () => {
  it("creates, reads, lists, and patches metadata", async () => {
    const service = await serviceWithAssistants();
    const created = await service.threads.create({ metadata: { a: 1 } });

    expect((await service.threads.get(created.thread_id)).thread_id).toBe(created.thread_id);
    expect((await service.threads.list()).length).toBe(1);

    const patched = await service.threads.patch(created.thread_id, { metadata: { a: 2 } });
    expect(patched.metadata).toMatchObject({ a: 2 });
  });

  it("404s an unknown thread on get and patch", async () => {
    const service = await serviceWithAssistants();
    await expect(service.threads.get("ghost")).rejects.toMatchObject({ status: 404 });
    await expect(service.threads.patch("ghost", { metadata: {} })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("searches threads by metadata and status with pagination", async () => {
    const service = await serviceWithAssistants();
    await service.threads.create({ metadata: { user: "alice" } });
    await service.threads.create({ metadata: { user: "bob" } });
    await service.threads.create({ metadata: { user: "alice" } });

    expect(await service.threads.search({ metadata: { user: "alice" } })).toHaveLength(2);
    expect(await service.threads.search({ limit: 1 })).toHaveLength(1);
  });

  it("copies a thread together with its checkpoint history", async () => {
    const service = await serviceWithAssistants();
    const thread = await service.threads.create({ metadata: { pinned: true } });
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
    });

    const copy = await service.threads.copy(thread.thread_id);
    expect(copy.thread_id).not.toBe(thread.thread_id);
    expect(copy.metadata).toMatchObject({ pinned: true });

    // The copy carries the source's graph state, read through the checkpointer under the new id.
    const copiedState = await service.threads.getState(copy.thread_id);
    expect(copiedState.values).toEqual({ value: "echo: hi" });
    const copiedHistory = await service.threads.history(copy.thread_id);
    const sourceHistory = await service.threads.history(thread.thread_id);
    expect(copiedHistory.length).toBe(sourceHistory.length);
  });

  it("404s copying an unknown thread", async () => {
    const service = await serviceWithAssistants();
    await expect(service.threads.copy("ghost")).rejects.toMatchObject({ status: 404 });
  });

  it("does not carry an in-flight run onto the copy (copy stays idle and runnable)", async () => {
    const deps = createFixtureDeps();
    const service = await serviceWithAssistants(deps);
    const thread = await service.threads.create();
    // A background run that no worker consumes stays pending (in-flight); simulate the busy thread too.
    await service.runs.createBackground(thread.thread_id, { assistant_id: "echo", input: {} });
    await deps.store.threads.update(thread.thread_id, { status: "busy" });
    expect(await deps.store.runs.hasActiveRun(thread.thread_id)).toBe(true);

    const copy = await service.threads.copy(thread.thread_id);
    // The in-flight run is skipped and the busy status is reset, so the copy can accept new runs.
    expect(await deps.store.runs.hasActiveRun(copy.thread_id)).toBe(false);
    expect((await service.threads.get(copy.thread_id)).status).toBe("idle");
  });

  it("deletes a thread and cascades its runs", async () => {
    const deps = createFixtureDeps();
    const service = await serviceWithAssistants(deps);
    const thread = await service.threads.create();
    const run = await service.runs.createBackground(thread.thread_id, {
      assistant_id: "echo",
      input: {},
    });

    await service.threads.delete(thread.thread_id);
    expect(await service.threads.get(thread.thread_id).catch((e) => e.status)).toBe(404);
    expect(await deps.store.runs.get(run.run_id)).toBeNull();
  });

  it("returns state history after a run", async () => {
    const service = await serviceWithAssistants();
    const thread = await service.threads.create();
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
    });

    const history = await service.threads.history(thread.thread_id);
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]?.values).toEqual({ value: "echo: hi" });
  });

  it("returns the current state snapshot via getState (what useStream hydrates from)", async () => {
    const service = await serviceWithAssistants();
    const thread = await service.threads.create();
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
    });

    const state = await service.threads.getState(thread.thread_id);
    expect(state.values).toEqual({ value: "echo: hi" });
  });

  it("getState on a thread with no run returns an empty state, not an error", async () => {
    const service = await serviceWithAssistants();
    const thread = await service.threads.create();

    const state = await service.threads.getState(thread.thread_id);
    expect(state.values).toEqual({});
    expect(state.next).toEqual([]);
    // The empty state still reports the real thread id (matches LangGraph), not a blank.
    expect(state.checkpoint?.thread_id).toBe(thread.thread_id);
  });

  it("getState returns a fresh empty-state object per call (no shared mutable singleton)", async () => {
    const service = await serviceWithAssistants();
    const a = await service.threads.create();
    const b = await service.threads.create();

    const stateA = await service.threads.getState(a.thread_id);
    const stateB = await service.threads.getState(b.thread_id);
    expect(stateA).not.toBe(stateB);
    expect(stateA.next).not.toBe(stateB.next);
  });
});

describe("thread service — time travel", () => {
  it("updateState forks a new checkpoint and mirrors the new values onto the thread", async () => {
    const service = await serviceWithAssistants();
    const thread = await service.threads.create();
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
    });
    const tip = (await service.threads.history(thread.thread_id))[0]?.checkpoint.checkpoint_id;

    const { checkpoint } = await service.threads.updateState(thread.thread_id, {
      values: { value: "forked" },
    });

    // A brand-new checkpoint id, distinct from the tip it forked off.
    expect(typeof checkpoint.checkpoint_id).toBe("string");
    expect(checkpoint.checkpoint_id).not.toBe(tip);
    expect(checkpoint.thread_id).toBe(thread.thread_id);
    // The forked values are now the thread tip (mirrored onto the row + readable via getState).
    expect((await service.threads.getState(thread.thread_id)).values).toEqual({ value: "forked" });
  });

  it("getStateAt reads the earlier checkpoint, distinct from the forked tip", async () => {
    const service = await serviceWithAssistants();
    const thread = await service.threads.create();
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
    });
    const tip =
      (await service.threads.history(thread.thread_id))[0]?.checkpoint.checkpoint_id ?? undefined;
    await service.threads.updateState(thread.thread_id, { values: { value: "forked" } });

    // Time-travel back to the pre-fork checkpoint: it still carries the original run's values.
    const past = await service.threads.getStateAt(thread.thread_id, tip!);
    expect(past.values).toEqual({ value: "echo: hi" });
    expect(past.checkpoint.checkpoint_id).toBe(tip);
  });

  it("getStateAt on an unknown checkpoint returns empty state, not an error", async () => {
    const service = await serviceWithAssistants();
    const thread = await service.threads.create();
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
    });

    const state = await service.threads.getStateAt(thread.thread_id, "no-such-checkpoint");
    expect(state.values).toEqual({});
  });

  it("getStateAt on a never-run thread returns an empty state", async () => {
    const service = await serviceWithAssistants();
    const thread = await service.threads.create();
    const state = await service.threads.getStateAt(thread.thread_id, "anything");
    expect(state.values).toEqual({});
  });

  it("404s updateState / getStateAt on an unknown thread", async () => {
    const service = await serviceWithAssistants();
    await expect(service.threads.updateState("ghost", { values: {} })).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.threads.getStateAt("ghost", "c1")).rejects.toMatchObject({ status: 404 });
  });

  it("409s updateState while a run is in flight (can't fork a busy thread)", async () => {
    const deps = createFixtureDeps();
    const service = await serviceWithAssistants(deps);
    const thread = await service.threads.create();
    // A background run no worker consumes stays pending — the thread is busy.
    await service.runs.createBackground(thread.thread_id, { assistant_id: "echo", input: {} });
    expect(await deps.store.runs.hasActiveRun(thread.thread_id)).toBe(true);

    await expect(
      service.threads.updateState(thread.thread_id, { values: { value: "x" } }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("422s updateState on a thread that has never produced a graph", async () => {
    const service = await serviceWithAssistants();
    const thread = await service.threads.create();
    await expect(
      service.threads.updateState(thread.thread_id, { values: { value: "x" } }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("ignores a client-supplied checkpoint.thread_id — a fork can't write into another thread", async () => {
    const service = await serviceWithAssistants();
    const victim = await service.threads.create();
    await service.runs.createWait({
      thread_id: victim.thread_id,
      assistant_id: "echo",
      input: { value: "victim" },
    });
    const attacker = await service.threads.create();
    await service.runs.createWait({
      thread_id: attacker.thread_id,
      assistant_id: "echo",
      input: { value: "attacker" },
    });

    // Try to redirect the write onto the victim's checkpoint history via the checkpoint pointer.
    await service.threads.updateState(attacker.thread_id, {
      values: { value: "poisoned" },
      checkpoint: { thread_id: victim.thread_id },
    });

    // The victim is untouched; the write landed on the attacker's own thread (server-owned thread_id wins).
    expect((await service.threads.getState(victim.thread_id)).values).toEqual({
      value: "echo: victim",
    });
    expect((await service.threads.getState(attacker.thread_id)).values).toEqual({
      value: "poisoned",
    });
  });
});
