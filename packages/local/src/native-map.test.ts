import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Annotation, StateGraph, interrupt } from "@langchain/langgraph";
import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { expect, it } from "vitest";

import { embedSqliteGraphs } from "./index.js";

it("rejects stale nested checkpoint maps after SQLite reopen and resumes the original root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skein-native-map-"));
  const state = Annotation.Root({ answer: Annotation<string> });
  let preparations = 0;
  const child = new StateGraph(state)
    .addNode("prepare", () => {
      preparations++;
      return {};
    })
    .addNode("ask", () => ({ answer: interrupt("approve?") }))
    .addEdge("__start__", "prepare")
    .addEdge("prepare", "ask")
    .addEdge("ask", "__end__")
    .compile();
  const graph = new StateGraph(state)
    .addNode("child", child)
    .addEdge("__start__", "child")
    .addEdge("child", "__end__")
    .compile();
  const options = { sqlitePath: join(directory, "state.sqlite") };
  let local = await embedSqliteGraphs({ nested: graph }, options);
  let runtime = createProtocolRuntime(local.deps, { scheduler: { enabled: false } });
  try {
    await runtime.service.assistants.registerGraphAssistants();
    let client = runtime.createNativeClient({ sourceId: "nested", allowedAssistants: ["nested"] });
    const first = await client.start(
      { assistant_id: "nested", input: {} },
      { idempotencyKey: "first" },
    );
    runtime.worker.start();
    for await (const _frame of await runtime.service.runs.join(first.runId)) {
      // Wait for persisted completion within the suite's real-file test budget.
    }
    expect((await client.getRun(first.runId)).status).toBe("interrupted");
    await runtime.worker.stop();
    const checkpoint = (await client.getState(first.threadId)).checkpoint;
    const history = [];
    for await (const tuple of local.deps.checkpointer.list({
      configurable: { thread_id: first.threadId },
    }))
      history.push(tuple);
    const namespace = history.find((tuple) => tuple.config.configurable?.["checkpoint_ns"])!.config
      .configurable!["checkpoint_ns"] as string;
    const current = (await local.deps.checkpointer.getTuple({
      configurable: { thread_id: first.threadId, checkpoint_ns: namespace },
    }))!;
    const earlier = history.find(
      (tuple) =>
        tuple.config.configurable?.["checkpoint_ns"] === namespace &&
        tuple.checkpoint.id !== current.checkpoint.id,
    )!;
    await local.dispose();
    local = await embedSqliteGraphs({ nested: graph }, options);
    runtime = createProtocolRuntime(local.deps, { scheduler: { enabled: false } });
    client = runtime.createNativeClient({ sourceId: "nested", allowedAssistants: ["nested"] });
    expect(await client.getReceipt("first")).toEqual(first);
    await expect(
      client.resume({
        assistant_id: "nested",
        thread_id: first.threadId,
        expected: {
          runId: first.runId,
          checkpoint: { ...checkpoint, checkpoint_map: { [namespace]: earlier.checkpoint.id } },
        },
        resume: "approve",
      }),
    ).rejects.toMatchObject({ code: "stale_resume" });
    const answer = await client.resume({
      assistant_id: "nested",
      thread_id: first.threadId,
      expected: { runId: first.runId, checkpoint },
      resume: "approve",
    });
    runtime.worker.start();
    for await (const _frame of await runtime.service.runs.join(answer.runId)) {
      // Nested checkpoint writes can outlast expect.poll's default one second on Windows.
    }
    expect((await client.getRun(answer.runId)).status).toBe("success");
    expect(preparations).toBe(1);
    expect((await client.getResult(answer.runId)).values).toEqual({ answer: "approve" });
  } finally {
    await runtime.worker.stop();
    await local.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
