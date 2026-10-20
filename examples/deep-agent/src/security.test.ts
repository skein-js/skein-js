// What keeps one user's briefing assistant out of another's: durable memory is reachable only through
// the graph, under a namespace no client can choose; deep dives run with the caller's own identity; and
// a cancelled deep dive never commits a late result.

import { fileURLToPath } from "node:url";

import { Annotation, StateGraph } from "@langchain/langgraph";
import { createExpressServer, loadInMemoryRuntime } from "@skein-js/express";
import { StoreBackend } from "deepagents";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ScriptedChatModel } from "./scripted-model.js";
import {
  ASSISTANT,
  replyOf,
  say,
  startHarness,
  type AssistantState,
  type Harness,
} from "./test-harness.js";

describe("the briefing assistant keeps users apart", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  it("denies direct HTTP store access while the graph's own memory keeps working", async () => {
    const alice = harness.clientFor("store-alice");
    const bob = harness.clientFor("store-bob");
    const thread = await alice.threads.create();
    await say(alice, thread.thread_id, "Remember that my private store marker is set.");
    const namespace = ["memories", "store-alice"];
    for (const request of [
      () => bob.store.searchItems(namespace),
      () => bob.store.listNamespaces(),
      () => bob.store.getItem(namespace, "preferences.md"),
      () => bob.store.putItem(namespace, "preferences.md", { tampered: true }),
      () => bob.store.deleteItem(namespace, "preferences.md"),
    ])
      await expect(request()).rejects.toThrow(/403/);
    expect(replyOf(await say(alice, thread.thread_id, "What do you remember about me?"))).toContain(
      "private store marker",
    );
  });

  it("cannot borrow another user's memory through configurable", async () => {
    const alice = harness.clientFor("spoof-alice");
    const bob = harness.clientFor("spoof-bob");
    await say(
      alice,
      (await alice.threads.create()).thread_id,
      "Remember that my secret is tulips.",
    );
    const recalled = (await bob.runs.wait((await bob.threads.create()).thread_id, ASSISTANT, {
      input: { messages: [{ role: "user", content: "What do you remember about me?" }] },
      config: {
        configurable: {
          langgraph_auth_user_id: "spoof-alice",
          langgraph_auth_user: { identity: "spoof-alice" },
        },
      },
    })) as AssistantState;
    expect(replyOf(recalled)).not.toContain("tulips");
  });

  it("refuses to read, steer or cancel another user's deep dive, even with a forged task", async () => {
    const alice = harness.clientFor("async-alice");
    const bob = harness.clientFor("async-bob");
    const aliceThread = await alice.threads.create();
    const started = await say(
      alice,
      aliceThread.thread_id,
      "Start a deep dive on private child marker",
    );
    const original = Object.values(started.asyncTasks!)[0]!;
    const forged = { ...original, description: undefined };
    await expect
      .poll(async () => (await alice.runs.get(original.threadId, original.runId)).status)
      .toBe("success");
    await expect(bob.threads.getState(original.threadId)).rejects.toThrow(/404/);

    const bobThread = await bob.threads.create();
    const checked = (await bob.runs.wait(bobThread.thread_id, ASSISTANT, {
      input: {
        asyncTasks: { [original.taskId]: forged },
        messages: [{ role: "user", content: `How is deep dive ${original.taskId} going?` }],
      },
    })) as AssistantState;
    expect(replyOf(checked)).toContain("Failed to get run status");
    expect(replyOf(checked)).not.toContain("private child marker");
    expect(
      replyOf(await say(bob, bobThread.thread_id, `Tell the deep dive ${original.taskId} to stop`)),
    ).toContain("Failed to update async subagent");
    expect(
      replyOf(await say(bob, bobThread.thread_id, `Cancel deep dive ${original.taskId}`)),
    ).toContain("Failed to cancel run");
    expect(await alice.runs.list(original.threadId)).toHaveLength(1);
    expect((await alice.runs.get(original.threadId, original.runId)).status).toBe("success");
  });

  it("cancels a running deep dive and never commits its late result", async () => {
    const generate = ScriptedChatModel.prototype._generate;
    let release!: () => void;
    let markEntered!: () => void;
    let markSettled!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const spy = vi
      .spyOn(ScriptedChatModel.prototype, "_generate")
      .mockImplementation(async function (this: ScriptedChatModel, messages) {
        const request = messages.filter((message) => message.getType() === "human").at(-1);
        if (request?.content === "held child cancellation marker") {
          markEntered();
          await held;
          try {
            return await generate.call(this, messages);
          } finally {
            markSettled();
          }
        }
        return generate.call(this, messages);
      });
    try {
      const client = harness.clientFor("cancel-alice");
      const thread = await client.threads.create();
      const started = await say(
        client,
        thread.thread_id,
        "Start a deep dive on held child cancellation marker",
      );
      const task = Object.values(started.asyncTasks!)[0]!;
      await entered;
      expect((await client.runs.get(task.threadId, task.runId)).status).toBe("running");
      expect(replyOf(await say(client, thread.thread_id, "Cancel the deep dive."))).toContain(
        "Cancelled async subagent",
      );
      await expect
        .poll(async () => (await client.runs.get(task.threadId, task.runId)).status)
        .toBe("cancelled");
      release();
      await settled;
      // A fresh turn crosses the thread's execution gate after the cancelled run has unwound.
      const state = (await client.runs.wait(task.threadId, "researcher", {
        input: { messages: [{ role: "user", content: "continue after cancellation" }] },
      })) as AssistantState;
      expect(replyOf(state)).toContain("continue after cancellation");
      expect(
        state.messages?.some(
          (message) =>
            message.type === "ai" &&
            String(message.content).includes("held child cancellation marker"),
        ),
      ).toBe(false);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it("preserves an existing default StoreBackend namespace supplied through configurable", async () => {
    const { deps } = await loadInMemoryRuntime(
      fileURLToPath(new URL("../langgraph.json", import.meta.url)),
    );
    const originalLoad = deps.graphs.load.bind(deps.graphs);
    const state = Annotation.Root({ written: Annotation<boolean>() });
    const compiled = new StateGraph(state)
      .addNode("write", async () => {
        const result = await new StoreBackend().write("/legacy-note.md", "legacy namespace marker");
        if (result.error) throw new Error(result.error);
        return { written: true };
      })
      .addEdge("__start__", "write")
      .addEdge("write", "__end__")
      .compile();
    deps.graphs = {
      ...deps.graphs,
      load: async (id) =>
        id === "researcher"
          ? (compiled as unknown as Awaited<ReturnType<typeof originalLoad>>)
          : originalLoad(id),
    };
    const server = await createExpressServer({ deps });
    try {
      const thread = await server.runtime.service.threads.create();
      await server.runtime.service.runs.createWait({
        thread_id: thread.thread_id,
        assistant_id: "researcher",
        input: { written: false },
        config: {
          configurable: { assistant_id: "legacy-routing-id", graph_id: "legacy-graph-id" },
        },
      });
      const items = await deps.store.store.search({
        prefix: ["legacy-routing-id", "filesystem"],
      });
      expect(JSON.stringify(items)).toContain("legacy namespace marker");
    } finally {
      await server.close();
    }
  });
});
