import { randomUUID } from "node:crypto";

import { Annotation, MemorySaver, StateGraph, interrupt } from "@langchain/langgraph";
import { expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { fixtureLangGraphAgent } from "../__fixtures__/lang-graph-binding.js";
import type { AgentGraph } from "../graphs/agent-graph.js";
import { createProtocolRuntime } from "../runtime.js";
import { toCheckpoint } from "../threads/thread-mirror.js";

async function fixture() {
  const state = Annotation.Root({ value: Annotation<string> });
  let preparations = 0;
  const leaf = new StateGraph(state)
    .addNode("prepare", () => {
      preparations++;
      return { value: "prepared" };
    })
    .addNode("ask", () => ({ value: `answer:${interrupt("approve?")}` }))
    .addEdge("__start__", "prepare")
    .addEdge("prepare", "ask")
    .addEdge("ask", "__end__")
    .compile();
  const child = new StateGraph(state)
    .addNode("leaf", leaf)
    .addEdge("__start__", "leaf")
    .addEdge("leaf", "__end__")
    .compile();
  const saver = new MemorySaver();
  const graph = new StateGraph(state)
    .addNode("child", child)
    .addEdge("__start__", "child")
    .addEdge("child", "__end__")
    .compile({ checkpointer: saver });
  const deps = createFixtureDeps({
    checkpointer: saver,
    graphs: {
      ids: ["nested"],
      schemas: async () => ({}),
      load: async () => fixtureLangGraphAgent(graph as unknown as AgentGraph),
    },
  });
  const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
  await runtime.service.assistants.registerGraphAssistants();
  const client = runtime.createNativeClient({ sourceId: "nested", allowedAssistants: ["nested"] });
  runtime.worker.start();
  const first = await client.start({ assistant_id: "nested", input: { value: "initial" } });
  await expect.poll(async () => (await client.getRun(first.runId)).status).toBe("interrupted");
  await runtime.worker.stop();
  const checkpoint = (await client.getState(first.threadId)).checkpoint;
  const root = await graph.getState(
    { configurable: { thread_id: first.threadId } },
    { subgraphs: true },
  );
  const childState = root.tasks[0]!.state as typeof root;
  const leafState = childState.tasks[0]!.state as typeof root;
  const nested = toCheckpoint(leafState.config)!;
  const history = [];
  for await (const tuple of saver.list({
    configurable: { thread_id: first.threadId, checkpoint_ns: nested.checkpoint_ns },
  }))
    history.push(tuple);
  const earlier = history.find((tuple) => tuple.metadata?.step === 0)!;
  expect(earlier.checkpoint.id).not.toBe(nested.checkpoint_id);
  return {
    runtime,
    client,
    first,
    checkpoint,
    nested,
    saver,
    earlier,
    preparations: () => preparations,
  };
}

it.each(["earlier", "missing", "foreign", "mixed"])(
  "rejects %s checkpoint-map coordinates before admission",
  async (variant) => {
    const fixtureState = await fixture();
    const { runtime, client, first, checkpoint, nested, earlier } = fixtureState;
    try {
      const checkpointMap =
        variant === "missing"
          ? { absent: randomUUID() }
          : {
              ...(variant === "mixed" ? { "": checkpoint.checkpoint_id! } : {}),
              [nested.checkpoint_ns]: variant === "foreign" ? randomUUID() : earlier.checkpoint.id,
            };
      await expect(
        client.resume(
          {
            assistant_id: "nested",
            thread_id: first.threadId,
            resume: "approved",
            expected: {
              runId: first.runId,
              checkpoint: { ...checkpoint, checkpoint_map: checkpointMap },
            },
          },
          { idempotencyKey: "answer" },
        ),
      ).rejects.toMatchObject({ code: "stale_resume" });
      expect(fixtureState.preparations()).toBe(1);
      await expect(client.getReceipt("answer")).rejects.toMatchObject({
        code: "receipt_unavailable",
      });
    } finally {
      await runtime.worker.stop();
    }
  },
);

it.each(["omitted", "empty", "current", "official-nested"])(
  "preserves %s coordinates for a nested interrupt",
  async (variant) => {
    const fixtureState = await fixture();
    const { runtime, client, first, checkpoint, nested } = fixtureState;
    try {
      const target =
        variant === "official-nested"
          ? nested
          : {
              ...checkpoint,
              checkpoint_map:
                variant === "omitted"
                  ? null
                  : variant === "empty"
                    ? {}
                    : {
                        "": checkpoint.checkpoint_id!,
                        [nested.checkpoint_ns]: nested.checkpoint_id!,
                      },
            };
      const answer = await client.resume({
        assistant_id: "nested",
        thread_id: first.threadId,
        expected: { runId: first.runId, checkpoint: target },
        resume: "approved",
      });
      runtime.worker.start();
      await expect
        .poll(async () => (await client.getRun(answer.runId)).status)
        .toMatch(/^(success|interrupted)$/);
      // Explicit nested coordinates retain LangGraph's existing nested time-travel behavior.
      expect(fixtureState.preparations()).toBe(variant === "official-nested" ? 2 : 1);
      if (variant === "omitted" || variant === "empty") {
        expect((await client.getRun(answer.runId)).status).toBe("success");
        expect((await client.getResult(answer.runId)).values).toEqual({ value: "answer:approved" });
      }
    } finally {
      await runtime.worker.stop();
    }
  },
);

it("revalidates mapped namespaces before invocation and retains an accepted receipt", async () => {
  const fixtureState = await fixture();
  const { runtime, client, first, checkpoint, nested, saver } = fixtureState;
  try {
    const input = {
      assistant_id: "nested",
      thread_id: first.threadId,
      resume: "approved",
      expected: {
        runId: first.runId,
        checkpoint: {
          ...checkpoint,
          checkpoint_map: { [nested.checkpoint_ns]: nested.checkpoint_id! },
        },
      },
    };
    const answer = await client.resume(input, { idempotencyKey: "answer" });
    const tip = (await saver.getTuple({
      configurable: { thread_id: first.threadId, checkpoint_ns: nested.checkpoint_ns },
    }))!;
    // MemorySaver selects its tip by checkpoint ID, so the replacement must sort after the original.
    await saver.put(
      tip.config,
      { ...tip.checkpoint, id: "ffffffff-ffff-6fff-bfff-ffffffffffff" },
      tip.metadata!,
    );
    runtime.worker.start();
    await expect.poll(async () => (await client.getRun(answer.runId)).status).toBe("error");
    expect(fixtureState.preparations()).toBe(1);
    expect(await client.resume(input, { idempotencyKey: "answer" })).toEqual(answer);
    await expect(client.resume(input, { idempotencyKey: "new-answer" })).rejects.toMatchObject({
      code: "stale_resume",
    });
  } finally {
    await runtime.worker.stop();
  }
});
