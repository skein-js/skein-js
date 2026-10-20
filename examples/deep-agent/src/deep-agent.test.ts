// End to end: a `createDeepAgent` export, served by skein from an unchanged `langgraph.json`, driven by
// the official `@langchain/langgraph-sdk` client — the way an application would use it. Offline: with no
// `DEEP_AGENT_MODEL`, both graphs think with the scripted model.

import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { Annotation, StateGraph } from "@langchain/langgraph";
import { Client } from "@langchain/langgraph-sdk";
import { createExpressServer, loadInMemoryRuntime } from "@skein-js/express";
import { StoreBackend, type AsyncTask } from "deepagents";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MEMORY_FILE, NOTES_FILE, ScriptedChatModel } from "./scripted-model.js";
import type { StartedExample } from "./server.js";

type Message = { type?: string; content?: unknown };
type AgentValues = {
  messages?: Message[];
  todos?: { content: string }[];
  files?: object;
  asyncTasks?: Record<string, AsyncTask>;
};

/** A port nothing is listening on — the async subagent has to know the server's URL before it boots. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

const lastText = (values: AgentValues): string => {
  const content = values.messages?.at(-1)?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
};

describe("a Deep Agent on skein", () => {
  let started: StartedExample;
  let clientFor: (user: string) => Client;

  beforeAll(async () => {
    const port = await freePort();
    process.env["SKEIN_URL"] = `http://127.0.0.1:${port}`;
    delete process.env["DEEP_AGENT_MODEL"];
    // Imported after the env is set: the graph modules read SKEIN_URL when they load.
    const { startServer } = await import("./server.js");
    started = await startServer(port);
    clientFor = (user) => new Client({ apiUrl: started.url, defaultHeaders: { "x-user": user } });
  });

  afterAll(async () => {
    await started?.close();
  });

  async function ask(client: Client, threadId: string, content: string): Promise<AgentValues> {
    return (await client.runs.wait(threadId, "supervisor", {
      input: { messages: [{ role: "user", content }] },
    })) as AgentValues;
  }

  it("plans with write_todos, in thread state", async () => {
    const client = clientFor("alice");
    const thread = await client.threads.create();

    const values = await ask(client, thread.thread_id, "plan: gather sources; draft summary");

    expect(values.todos?.map((todo) => todo.content)).toEqual(["gather sources", "draft summary"]);
  });

  it("keeps a thread's files across its turns, and only that thread's", async () => {
    const client = clientFor("alice");
    const thread = await client.threads.create();

    await ask(client, thread.thread_id, "note: the tide turns at six");
    const later = await ask(client, thread.thread_id, "read-note");
    expect(lastText(later)).toContain("the tide turns at six");
    expect(Object.keys(later.files ?? {})).toContain(NOTES_FILE);

    const otherThread = await client.threads.create();
    const elsewhere = await ask(client, otherThread.thread_id, "read-note");
    expect(lastText(elsewhere)).not.toContain("the tide turns at six");
  });

  it("keeps /memories/ across threads for the same user, and apart between users", async () => {
    const alice = clientFor("alice");
    const bob = clientFor("bob");

    await ask(
      alice,
      (await alice.threads.create()).thread_id,
      "remember: alice takes her tea black",
    );

    const aliceLater = await ask(alice, (await alice.threads.create()).thread_id, "recall");
    expect(lastText(aliceLater)).toContain("alice takes her tea black");
    // Durable memory lives in the store, not in the thread.
    expect(Object.keys(aliceLater.files ?? {})).not.toContain(MEMORY_FILE);

    const bobLater = await ask(bob, (await bob.threads.create()).thread_id, "recall");
    expect(lastText(bobLater)).not.toContain("alice takes her tea black");
  });

  it("streams the synchronous subagent under its own namespace when asked", async () => {
    const client = clientFor("alice");
    const thread = await client.threads.create();
    const events: string[] = [];

    for await (const chunk of client.runs.stream(thread.thread_id, "supervisor", {
      input: { messages: [{ role: "user", content: "research: why tides turn" }] },
      streamMode: ["updates"],
      streamSubgraphs: true,
    })) {
      events.push(chunk.event);
    }

    // The supervisor's own frames keep the bare mode; the subagent's carry the `task` tool call's
    // namespace, which is what lets the SDK's UI helpers render the two apart.
    expect(events).toContain("updates");
    expect(events.some((event) => /^updates\|tools:[\w-]+$/.test(event))).toBe(true);
  });

  it("streams only the supervisor when subgraphs are not asked for", async () => {
    const client = clientFor("alice");
    const thread = await client.threads.create();
    const events: string[] = [];

    for await (const chunk of client.runs.stream(thread.thread_id, "supervisor", {
      input: { messages: [{ role: "user", content: "research: why tides turn" }] },
      streamMode: ["updates"],
    })) {
      events.push(chunk.event);
    }

    expect(events.filter((event) => event.includes("|"))).toEqual([]);
  });

  describe("a sensitive tool waits for a human", () => {
    async function pause(client: Client) {
      const thread = await client.threads.create();
      await ask(client, thread.thread_id, "send: ops@example.test | weekly numbers");
      const state = await client.threads.getState(thread.thread_id);
      expect(state.next.length).toBeGreaterThan(0);
      return thread.thread_id;
    }

    async function decide(client: Client, threadId: string, decision: object): Promise<string> {
      const values = (await client.runs.wait(threadId, "supervisor", {
        command: { resume: { decisions: [decision] } },
      })) as AgentValues;
      return lastText(values);
    }

    it("runs the tool once approved", async () => {
      const client = clientFor("alice");
      const threadId = await pause(client);

      expect(await decide(client, threadId, { type: "approve" })).toContain(
        'Sent "weekly numbers" to ops@example.test.',
      );
    });

    it("runs the tool with the human's edits", async () => {
      const client = clientFor("alice");
      const threadId = await pause(client);
      const edited = {
        type: "edit",
        editedAction: { name: "send_report", args: { to: "lead@example.test", body: "weekly" } },
      };

      expect(await decide(client, threadId, edited)).toContain(
        'Sent "weekly" to lead@example.test.',
      );
    });

    it("does not run the tool once rejected", async () => {
      const client = clientFor("alice");
      const threadId = await pause(client);

      const reply = await decide(client, threadId, { type: "reject", message: "not this week" });
      expect(reply).not.toContain("Sent");
    });
  });

  it("starts, checks and actually updates an async subagent over the Agent Protocol", async () => {
    const client = clientFor("alice");
    const thread = await client.threads.create();

    const launched = lastText(await ask(client, thread.thread_id, "background: ocean currents"));
    const taskId = /taskId: ([\w-]+)/.exec(launched)?.[1];
    expect(taskId).toBeDefined();

    // The subagent runs as an ordinary background run on this server; wait for it to settle.
    const service = client;
    await expect
      .poll(async () => (await service.runs.list(taskId!)).at(0)?.status, { timeout: 10_000 })
      .toBe("success");

    const checked = lastText(await ask(client, thread.thread_id, `check: ${taskId}`));
    expect(checked).toContain("success");
    expect(checked).toContain("ocean currents");

    const updated = await ask(
      client,
      thread.thread_id,
      `update: ${taskId} | focus on the Gulf Stream`,
    );
    expect(lastText(updated)).toContain(taskId!);
    const nextRunId = updated.asyncTasks![taskId!]!.runId;
    await expect
      .poll(async () => (await client.runs.get(taskId!, nextRunId)).status)
      .toBe("success");
    expect(lastText((await client.threads.getState(taskId!)).values as AgentValues)).toContain(
      "focus on the Gulf Stream",
    );
  });

  it("denies direct HTTP store access while graph memory remains usable", async () => {
    const alice = clientFor("store-alice");
    const bob = clientFor("store-bob");
    const thread = await alice.threads.create();
    await ask(alice, thread.thread_id, "remember: private store marker");
    const namespace = ["memories", "store-alice"];
    for (const request of [
      () => bob.store.searchItems(namespace),
      () => bob.store.listNamespaces(),
      () => bob.store.getItem(namespace, "facts.md"),
      () => bob.store.putItem(namespace, "facts.md", { tampered: true }),
      () => bob.store.deleteItem(namespace, "facts.md"),
    ])
      await expect(request()).rejects.toThrow(/403/);
    expect(lastText(await ask(alice, thread.thread_id, "recall"))).toContain(
      "private store marker",
    );
  });

  it("cannot borrow another user's memory identity through configurable", async () => {
    const alice = clientFor("spoof-alice");
    const bob = clientFor("spoof-bob");
    await ask(alice, (await alice.threads.create()).thread_id, "remember: caller identity secret");
    const recalled = (await bob.runs.wait((await bob.threads.create()).thread_id, "supervisor", {
      input: { messages: [{ role: "user", content: "recall" }] },
      config: {
        configurable: {
          langgraph_auth_user_id: "spoof-alice",
          langgraph_auth_user: { identity: "spoof-alice" },
        },
      },
    })) as AgentValues;
    expect(lastText(recalled)).not.toContain("caller identity secret");
  });

  it("rejects cross-user async reads, updates and cancellation even with forged task input", async () => {
    const alice = clientFor("async-alice");
    const bob = clientFor("async-bob");
    const aliceThread = await alice.threads.create();
    const launched = await ask(alice, aliceThread.thread_id, "background: private child marker");
    const original = Object.values(launched.asyncTasks!)[0]!;
    const forged = { ...original, description: undefined };
    await expect
      .poll(async () => (await alice.runs.get(original.threadId, original.runId)).status)
      .toBe("success");
    await expect(bob.threads.getState(original.threadId)).rejects.toThrow(/404/);
    const bobThread = await bob.threads.create();
    const checked = (await bob.runs.wait(bobThread.thread_id, "supervisor", {
      input: {
        asyncTasks: { [original.taskId]: forged },
        messages: [{ role: "user", content: `check: ${original.taskId}` }],
      },
    })) as AgentValues;
    expect(lastText(checked)).toContain("Failed to get run status");
    expect(lastText(checked)).not.toContain("private child marker");
    expect(
      lastText(await ask(bob, bobThread.thread_id, `update: ${original.taskId} | foreign update`)),
    ).toContain("Failed to update async subagent");
    expect(lastText(await ask(bob, bobThread.thread_id, `cancel: ${original.taskId}`))).toContain(
      "Failed to cancel run",
    );
    expect(await alice.runs.list(original.threadId)).toHaveLength(1);
    expect((await alice.runs.get(original.threadId, original.runId)).status).toBe("success");
  });

  it("cancels a running async child and prevents its delayed result from being committed", async () => {
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
      const client = clientFor("cancel-alice");
      const thread = await client.threads.create();
      const launched = await ask(
        client,
        thread.thread_id,
        "background: held child cancellation marker",
      );
      const task = Object.values(launched.asyncTasks!)[0]!;
      await entered;
      expect((await client.runs.get(task.threadId, task.runId)).status).toBe("running");
      expect(lastText(await ask(client, thread.thread_id, `cancel: ${task.taskId}`))).toContain(
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
      })) as AgentValues;
      expect(lastText(state)).toContain("continue after cancellation");
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
