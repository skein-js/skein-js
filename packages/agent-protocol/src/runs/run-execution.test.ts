import { expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";

import { startRunExecution } from "./run-execution.js";

it("reuses a preclaimed lease and rereads terminal status before rollback effects", async () => {
  const acquire = vi.fn(async () => {
    throw new Error("Must not reacquire");
  });
  const deps = createFixtureDeps({ threadExecutionGate: { acquire } });
  const ctx = createContext(deps);
  const thread = await deps.store.threads.create();
  const run = await deps.store.runs.create({ thread_id: thread.thread_id, assistant_id: "echo" });
  await deps.store.runs.setStatus(run.run_id, "cancelled");
  const release = vi.fn(async () => undefined);
  const load = vi.spyOn(deps.graphs, "load");
  expect((await startRunExecution(ctx, run, {}, {}, { release })).status).toBe("cancelled");
  expect(load).not.toHaveBeenCalled();
  expect(acquire).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});

it("releases an already lost preclaimed lease without invoking a graph", async () => {
  const deps = createFixtureDeps();
  const ctx = createContext(deps);
  const thread = await deps.store.threads.create();
  const run = await deps.store.runs.create({ thread_id: thread.thread_id, assistant_id: "echo" });
  const release = vi.fn(async () => undefined);
  const load = vi.spyOn(deps.graphs, "load");
  const lost = AbortSignal.abort(new Error("Claim lost"));
  await expect(startRunExecution(ctx, run, {}, {}, { release, signal: lost })).rejects.toThrow(
    "Claim lost",
  );
  expect(load).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});

it("skips a recovered terminal run before reapplying its persisted rollback", async () => {
  const deps = createFixtureDeps();
  const context = createContext(deps);
  const thread = await deps.store.threads.create();
  const displaced = await deps.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    status: "success",
  });
  const run = await deps.store.runs.create({ thread_id: thread.thread_id, assistant_id: "echo" });
  const kwargs = {
    rollback_plan: {
      revert_to_checkpoint: { base_checkpoint_id: null },
      displaced_run_ids: [displaced.run_id],
    },
  };
  context.rollbackPlans.set(run.run_id, {
    revertToCheckpoint: { baseCheckpointId: undefined },
    displacedRunIds: [displaced.run_id],
  });
  await deps.store.runs.setStatus(run.run_id, "cancelled");
  const deleteCheckpoints = vi.spyOn(deps.checkpointer, "deleteThread");
  const deleteRun = vi.spyOn(deps.store.runs, "delete");
  const loadGraph = vi.spyOn(deps.graphs, "load");
  // The queued worker's stale pending snapshot must not authorize any rollback effects.
  expect((await startRunExecution(context, run, kwargs)).status).toBe("cancelled");
  expect(deleteCheckpoints).not.toHaveBeenCalled();
  expect(deleteRun).not.toHaveBeenCalled();
  expect(loadGraph).not.toHaveBeenCalled();
  expect(context.rollbackPlans.has(run.run_id)).toBe(false);
  expect(await deps.store.runs.get(displaced.run_id)).not.toBeNull();
});

it("stops rollback and completion cleanup after observed lease loss during a checkpoint read", async () => {
  const lost = new AbortController();
  const deps = createFixtureDeps({
    threadExecutionGate: {
      acquire: async () => ({ signal: lost.signal, release: async () => undefined }),
    },
  });
  const context = createContext(deps);
  const thread = await deps.store.threads.create();
  const displaced = await deps.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    status: "success",
  });
  const run = await deps.store.runs.create({ thread_id: thread.thread_id, assistant_id: "echo" });
  vi.spyOn(deps.checkpointer, "list").mockImplementation(async function* () {
    lost.abort(new Error("execution connection lost"));
    yield { config: { configurable: {} }, checkpoint: { id: "base" } };
  });
  const deleteCheckpoints = vi.spyOn(deps.checkpointer, "deleteThread");
  const putCheckpoint = vi.spyOn(deps.checkpointer, "put");
  const deleteRun = vi.spyOn(deps.store.runs, "delete");
  await expect(
    startRunExecution(context, run, {
      delete_thread_on_completion: true,
      rollback_plan: {
        revert_to_checkpoint: { base_checkpoint_id: "base" },
        displaced_run_ids: [displaced.run_id],
      },
    }),
  ).rejects.toThrow("execution connection lost");
  expect(deleteCheckpoints).not.toHaveBeenCalled();
  expect(putCheckpoint).not.toHaveBeenCalled();
  expect(deleteRun).not.toHaveBeenCalled();
  expect(await deps.store.threads.get(thread.thread_id)).not.toBeNull();
});

it("does not invoke a graph after the execution lease is lost during graph loading", async () => {
  const lost = new AbortController();
  const deps = createFixtureDeps({
    threadExecutionGate: {
      acquire: async () => ({ signal: lost.signal, release: async () => undefined }),
    },
  });
  await deps.store.assistants.create({ assistant_id: "echo", graph_id: "echo" });
  const thread = await deps.store.threads.create();
  const run = await deps.store.runs.create({ thread_id: thread.thread_id, assistant_id: "echo" });
  const stream = vi.fn(async function* () {
    yield ["values", {}];
  });
  deps.graphs.load = async () => {
    lost.abort(new Error("execution connection lost"));
    return { stream, getState: async () => ({ values: {}, next: [], tasks: [] }) };
  };
  expect((await startRunExecution(createContext(deps), run, { input: {} })).status).toBe(
    "cancelled",
  );
  expect(stream).not.toHaveBeenCalled();
});
