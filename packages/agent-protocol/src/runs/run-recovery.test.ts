import { Annotation, Command, interrupt, StateGraph } from "@langchain/langgraph";
import type { RunKwargs } from "@skein-js/core";
import { describe, expect, it, vi } from "vitest";

import { createFixtureDeps, createFixtureResolver } from "../__fixtures__/deps.js";
import { fixtureLangGraphAgent } from "../__fixtures__/lang-graph-binding.js";
import { createContext } from "../context.js";

import { withCheckpointRunIdentity } from "./checkpoint-run-identity.js";
import { startRunExecution } from "./run-execution.js";
import { preservesRecoveryInterrupt } from "./run-recovery.js";

const state = Annotation.Root({
  total: Annotation<number>({ reducer: (previous, next) => previous + next, default: () => 0 }),
  steps: Annotation<string[]>({
    reducer: (previous, next) => [...previous, ...next],
    default: () => [],
  }),
});

async function fixture(pauses = false, overrides: RunKwargs = {}) {
  const graph = new StateGraph(state)
    .addNode("first", () => ({ total: 10, steps: ["first"] }))
    .addNode("second", () => {
      if (pauses) interrupt("Approve?");
      return { total: 100, steps: ["second"] };
    })
    .addEdge("__start__", "first")
    .addEdge("first", "second")
    .addEdge("second", "__end__")
    .compile();
  const deps = createFixtureDeps({
    graphs: {
      ...createFixtureResolver(),
      ids: ["recovery"],
      load: async () => fixtureLangGraphAgent(graph),
    },
  });
  const context = createContext(deps);
  const assistant = await deps.store.assistants.create({ graph_id: "recovery" });
  const thread = await deps.store.threads.create();
  const input = { total: 1 };
  const kwargs: RunKwargs = { input, durability: "sync", ...overrides };
  const run = await deps.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: assistant.assistant_id,
    kwargs,
  });
  const checkpointed = Object.assign(Object.create(graph) as typeof graph, {
    checkpointer: withCheckpointRunIdentity(deps.checkpointer, run.run_id),
  });
  const config = {
    configurable: { thread_id: thread.thread_id },
    metadata: { run_id: run.run_id },
  };
  const recover = () => startRunExecution(context, run, kwargs, { trigger: "background" });
  return { deps, graph: checkpointed, context, run, thread, input, kwargs, config, recover };
}

describe("same-run checkpoint recovery", () => {
  it("supports frozen structural savers and preserves a class saver's constructor and owner", async () => {
    const saver = createFixtureDeps().checkpointer;
    const frozen = Object.freeze({
      getTuple: saver.getTuple.bind(saver),
      list: saver.list.bind(saver),
      put: vi.fn(saver.put.bind(saver)),
      putWrites: saver.putWrites.bind(saver),
      deleteThread: saver.deleteThread.bind(saver),
    });
    const wrapped = withCheckpointRunIdentity(frozen, "run");
    expect(await wrapped.getTuple({ configurable: { thread_id: "empty" } })).toBeUndefined();
    expect(Object.keys(wrapped)).toEqual(Object.keys(frozen));
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(withCheckpointRunIdentity(saver, "run").constructor).toBe(saver.constructor);
  });
  it("retains resume validation before graph-factory initialization on a fresh attempt", async () => {
    const f = await fixture();
    Object.assign(f.kwargs, { a2a_origin: { expectedRunId: "another-run" } });
    const load = vi.spyOn(f.deps.graphs, "load");
    expect((await f.recover()).status).toBe("error");
    expect(load).not.toHaveBeenCalled();
  });
  it("refuses to cross a static interrupt when its preceding checkpoint was pruned", async () => {
    const f = await fixture();
    await f.graph.invoke(f.input, { ...f.config, interruptAfter: ["first"], durability: "sync" });
    const snapshot = await f.graph.getState(f.config);
    const pruned = {
      stream: f.graph.stream.bind(f.graph),
      getState: f.graph.getState.bind(f.graph),
      async *getStateHistory() {
        yield snapshot;
      },
    };
    await expect(
      preservesRecoveryInterrupt(pruned, snapshot, { interrupt_after: ["first"] }),
    ).rejects.toMatchObject({ code: "run_recovery_ambiguous" });
  });
  it("preserves opaque metadata supplied by custom checkpoint drivers", async () => {
    const checkpointer = createFixtureDeps().checkpointer;
    const put = vi.spyOn(checkpointer, "put").mockResolvedValue({});
    const wrapped = withCheckpointRunIdentity(checkpointer, "run");
    for (const metadata of ["opaque", null, [1, 2], new Date("2026-11-09T00:00:00Z")]) {
      await wrapped.put({}, { id: "checkpoint" }, metadata, {});
      expect(put.mock.calls.at(-1)?.[2]).toBe(metadata);
    }
  });
  it("continues pending work without applying original input twice and retains the original rollback base", async () => {
    const f = await fixture();
    await f.deps.store.runs.recordBaseCheckpoint(f.run.run_id, null);
    await f.deps.store.runs.setStatus(f.run.run_id, "running");
    await f.graph.invoke(f.input, { ...f.config, interruptAfter: ["first"], durability: "sync" });
    expect((await f.graph.getState(f.config)).metadata).toMatchObject({ run_id: f.run.run_id });
    const outcome = await f.recover();
    expect(outcome.error).toBeUndefined();
    expect(outcome.values).toEqual({ total: 111, steps: ["first", "second"] });
    expect((await f.deps.store.runs.getKwargs(f.run.run_id))?.base_checkpoint_id).toBeNull();
  });

  it("starts the original input when a crash precedes the first checkpoint", async () => {
    const f = await fixture();
    await f.deps.store.runs.setStatus(f.run.run_id, "running");
    expect((await f.recover()).values).toEqual({ total: 111, steps: ["first", "second"] });
  });

  it("does not repeat a completed graph when terminal resource settlement was lost", async () => {
    const f = await fixture();
    await f.deps.store.runs.setStatus(f.run.run_id, "running");
    await f.graph.invoke(f.input, { ...f.config, durability: "sync" });
    expect((await f.recover()).values).toEqual({ total: 111, steps: ["first", "second"] });
  });

  it("preserves an unanswered dynamic interrupt instead of approving it through recovery", async () => {
    const f = await fixture(true);
    await f.deps.store.runs.setStatus(f.run.run_id, "running");
    await f.graph.invoke(f.input, { ...f.config, durability: "sync" });
    const outcome = await f.recover();
    expect(outcome.status).toBe("interrupted");
    expect(outcome.values).toEqual({ total: 11, steps: ["first"] });
  });

  it("does not apply a command update again after its checkpoint", async () => {
    const f = await fixture(false, {
      input: undefined,
      command: { update: { total: 5 }, goto: "first" },
    });
    await f.deps.store.runs.setStatus(f.run.run_id, "running");
    await f.graph.invoke(new Command({ update: { total: 5 }, goto: "first" }), {
      ...f.config,
      interruptAfter: ["first"],
      durability: "sync",
    });
    expect((await f.recover()).values).toEqual({ total: 115, steps: ["first", "second"] });
  });

  it.each(["before", "after"] as const)(
    "preserves an unsettled static interrupt %s a node",
    async (boundary) => {
      const f = await fixture(
        false,
        boundary === "before" ? { interrupt_before: ["second"] } : { interrupt_after: ["first"] },
      );
      await f.deps.store.runs.setStatus(f.run.run_id, "running");
      await f.graph.invoke(f.input, { ...f.config, interruptAfter: ["first"], durability: "sync" });
      const outcome = await f.recover();
      expect(outcome.status).toBe("interrupted");
      expect(outcome.values).toEqual({ total: 11, steps: ["first"] });
    },
  );

  it("does not resume or replay an unattributable older checkpoint", async () => {
    const f = await fixture();
    Object.assign(f.graph, { checkpointer: f.deps.checkpointer });
    await f.graph.invoke({ total: 2 }, { configurable: f.config.configurable, durability: "sync" });
    await f.deps.store.runs.setStatus(f.run.run_id, "running");
    const stream = vi.spyOn(f.graph, "stream");
    const outcome = await f.recover();
    expect(outcome.status).toBe("error");
    expect(outcome.error?.message).toContain("run_recovery_ambiguous");
    expect(outcome.error?.message).toContain("not attributable");
    expect(stream).not.toHaveBeenCalled();
    expect((await f.graph.getState(f.config)).values).toEqual({
      total: 112,
      steps: ["first", "second"],
    });
  });

  it("allows a fresh turn over an older checkpoint with a different run identity", async () => {
    const f = await fixture();
    Object.assign(f.graph, { checkpointer: withCheckpointRunIdentity(f.deps.checkpointer, "old") });
    await f.graph.invoke(
      { total: 2 },
      { configurable: f.config.configurable, metadata: { run_id: "old" } },
    );
    const outcome = await f.recover();
    expect(outcome.values).toEqual({ total: 223, steps: ["first", "second", "first", "second"] });
  });

  it("skips cancellation and terminal redelivery before touching graph state", async () => {
    const f = await fixture();
    await f.deps.store.runs.setStatus(f.run.run_id, "cancelled");
    const load = vi.spyOn(f.deps.graphs, "load");
    expect((await f.recover()).status).toBe("cancelled");
    expect(load).not.toHaveBeenCalled();
  });
});
