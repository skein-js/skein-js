import { MemorySaver, type CompiledGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { echoGraph } from "../__fixtures__/graphs.js";

import { copyCheckpointHistory, rollbackThreadCheckpointsTo } from "./checkpoint-history.js";

// Bind a fresh MemorySaver to the echo graph and drive it, so tests build real checkpoint history.
function graphWithSaver(): { graph: CompiledGraph<string>; saver: MemorySaver } {
  const saver = new MemorySaver();
  const graph = echoGraph;
  (graph as { checkpointer?: unknown }).checkpointer = saver;
  return { graph, saver };
}

const at = (threadId: string) => ({ configurable: { thread_id: threadId } });

describe("rollbackThreadCheckpointsTo", () => {
  it("reverts a thread to an earlier checkpoint, dropping later writes", async () => {
    const { graph, saver } = graphWithSaver();
    const threadId = "t-revert";

    await graph.invoke({ value: "first" }, at(threadId));
    const base = (await saver.getTuple(at(threadId)))?.checkpoint.id;
    expect(base).toBeDefined();

    await graph.invoke({ value: "second" }, at(threadId));
    expect((await graph.getState(at(threadId))).values).toEqual({ value: "echo: second" });

    await rollbackThreadCheckpointsTo(saver, threadId, base);

    // The thread is back to where it was after the first run — the second run's writes are gone.
    expect((await graph.getState(at(threadId))).values).toEqual({ value: "echo: first" });
    expect((await saver.getTuple(at(threadId)))?.checkpoint.id).toBe(base);
  });

  it("wipes the thread when the base is undefined (started on a fresh thread)", async () => {
    const { graph, saver } = graphWithSaver();
    const threadId = "t-wipe";

    await graph.invoke({ value: "only" }, at(threadId));
    expect(await saver.getTuple(at(threadId))).toBeDefined();

    await rollbackThreadCheckpointsTo(saver, threadId, undefined);

    expect(await saver.getTuple(at(threadId))).toBeUndefined();
  });

  it("leaves history untouched when the base id is no longer present", async () => {
    const { graph, saver } = graphWithSaver();
    const threadId = "t-missing";

    await graph.invoke({ value: "kept" }, at(threadId));
    const tip = (await saver.getTuple(at(threadId)))?.checkpoint.id;

    await rollbackThreadCheckpointsTo(saver, threadId, "does-not-exist");

    // Unknown base → no-op, so valid state is never destroyed.
    expect((await saver.getTuple(at(threadId)))?.checkpoint.id).toBe(tip);
  });
});

describe("copyCheckpointHistory", () => {
  it("replays a thread's history under a new id", async () => {
    const { graph, saver } = graphWithSaver();
    await graph.invoke({ value: "hi" }, at("source"));

    await copyCheckpointHistory(saver, "source", "target");

    expect((await graph.getState(at("target"))).values).toEqual({ value: "echo: hi" });
  });
});
