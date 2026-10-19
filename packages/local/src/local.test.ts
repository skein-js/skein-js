import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Annotation, interrupt, StateGraph } from "@langchain/langgraph";
import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { describe, expect, it } from "vitest";

import { embedSqliteGraphs } from "./index.js";

const state = Annotation.Root({
  value: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
});
const graph = new StateGraph(state)
  .addNode("approve", () => ({
    value: interrupt("Approve local action?") ? "approved" : "declined",
  }))
  .addEdge("__start__", "approve")
  .addEdge("approve", "__end__")
  .compile();

describe("local assembly and upstream checkpoints", () => {
  it("reopens an approval, resumes it, copies and forks checkpoints, then prunes and deletes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skein-local-"));
    const sqlitePath = join(directory, "state.sqlite");
    let embedded = await embedSqliteGraphs({ approval: graph }, { sqlitePath });
    try {
      let runtime = createProtocolRuntime(embedded.deps, { scheduler: { enabled: false } });
      await runtime.service.assistants.registerGraphAssistants();
      const thread = await runtime.service.threads.create();
      const paused = await runtime.service.runs.createWait({
        thread_id: thread.thread_id,
        assistant_id: "approval",
        input: { value: "waiting" },
      });
      expect((await runtime.service.runs.get(paused.runId)).status).toBe("interrupted");
      const history = await runtime.service.threads.history(thread.thread_id);
      expect(history.length).toBeGreaterThan(0);
      await embedded.dispose();
      embedded = await embedSqliteGraphs({ approval: graph }, { sqlitePath });
      runtime = createProtocolRuntime(embedded.deps, { scheduler: { enabled: false } });
      expect((await runtime.service.threads.getState(thread.thread_id)).next).toEqual(["approve"]);
      const resumed = await runtime.service.runs.createWait({
        thread_id: thread.thread_id,
        assistant_id: "approval",
        command: { resume: true },
      });
      expect(resumed.result).toEqual({ value: "approved" });
      const copied = await runtime.service.threads.copy(thread.thread_id);
      expect((await runtime.service.threads.getState(copied.thread_id)).values).toEqual({
        value: "approved",
      });
      const fork = await runtime.service.threads.updateState(thread.thread_id, {
        values: { value: "fork" },
      });
      expect(fork.checkpoint.checkpoint_id).toBeTruthy();
      expect(
        (
          await runtime.service.threads.getStateAt(
            thread.thread_id,
            history[0]!.checkpoint.checkpoint_id!,
          )
        ).values,
      ).toEqual({ value: "waiting" });
      expect(
        await runtime.service.threads.prune({
          threadIds: [thread.thread_id],
          strategy: "keep_latest",
        }),
      ).toEqual({ pruned_count: 1 });
      expect(await runtime.service.threads.history(thread.thread_id)).toHaveLength(1);
      await runtime.service.threads.delete(copied.thread_id);
      expect(
        await embedded.deps.checkpointer.getTuple({
          configurable: { thread_id: copied.thread_id },
        }),
      ).toBeUndefined();
      const frames = [];
      for await (const frame of await runtime.service.runs.join(paused.runId)) frames.push(frame);
      expect(frames).toEqual([]);
    } finally {
      await embedded.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("initializes the saver before deletion of a never-run thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skein-local-empty-"));
    const embedded = await embedSqliteGraphs({}, { sqlitePath: join(directory, "state.sqlite") });
    try {
      await embedded.deps.checkpointer.deleteThread("never-created");
    } finally {
      await embedded.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("polls persisted delivery leases after reopening without a separate delivery queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skein-outbox-"));
  const sqlitePath = join(directory, "state.sqlite");
  let embedded = await embedSqliteGraphs({}, { sqlitePath });
  try {
    const thread = await embedded.deps.store.threads.create();
    const run = await embedded.deps.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "a",
    });
    const at = new Date().toISOString();
    const final = await embedded.deps.store.runs.finalizeWithDelivery!(run.run_id, {
      status: "success",
      delivery: {
        thread_id: thread.thread_id,
        url: "https://example.test/delivery",
        payload: { persisted: true },
        next_attempt_at: at,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    await embedded.dispose();
    const received: unknown[] = [];
    embedded = await embedSqliteGraphs(
      {},
      {
        sqlitePath,
        overrides: {
          webhookDispatcher: async (_url, payload) => {
            received.push(payload);
          },
        },
      },
    );
    const runtime = createProtocolRuntime(embedded.deps);
    await runtime.deliveryWorker.tickOnce();
    expect(received).toEqual([expect.objectContaining({ persisted: true, status: "success" })]);
    expect((await embedded.deps.store.deliveries!.get(final.delivery.delivery_id))?.status).toBe(
      "delivered",
    );
  } finally {
    await embedded.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

it("thread retention removes checkpoints through the existing protocol sweeper", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skein-thread-ttl-"));
  const embedded = await embedSqliteGraphs(
    { approval: graph },
    { sqlitePath: join(directory, "state.sqlite"), threadTtl: { defaultTtl: 0.0001 } },
  );
  try {
    const runtime = createProtocolRuntime(embedded.deps);
    await runtime.service.assistants.registerGraphAssistants();
    const thread = await runtime.service.threads.create();
    await runtime.service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "approval",
      input: { value: "waiting" },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runtime.threadTtlSweeper.sweepOnce();
    expect(await embedded.deps.store.threads.get(thread.thread_id)).toBeNull();
    expect(
      await embedded.deps.checkpointer.getTuple({ configurable: { thread_id: thread.thread_id } }),
    ).toBeUndefined();
  } finally {
    await embedded.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

it("forks a run and rolls checkpoint writes back through the upstream saver", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skein-rollback-"));
  const echo = new StateGraph(state)
    .addNode("echo", (current) => ({ value: current.value }))
    .addEdge("__start__", "echo")
    .addEdge("echo", "__end__")
    .compile();
  const embedded = await embedSqliteGraphs(
    { echo },
    { sqlitePath: join(directory, "state.sqlite") },
  );
  try {
    const runtime = createProtocolRuntime(embedded.deps);
    await runtime.service.assistants.registerGraphAssistants();
    const thread = await runtime.service.threads.create();
    await runtime.service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "baseline" },
    });
    const first = (await runtime.service.threads.history(thread.thread_id))[0]!.checkpoint
      .checkpoint_id!;
    await runtime.service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      checkpoint_id: first,
      input: { value: "forked" },
    });
    const base = (await runtime.service.threads.history(thread.thread_id))[0]!.checkpoint
      .checkpoint_id!;
    await runtime.service.threads.updateState(thread.thread_id, {
      values: { value: "speculative" },
    });
    const running = await embedded.deps.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      status: "running",
    });
    await embedded.deps.store.runs.recordBaseCheckpoint(running.run_id, base);
    await runtime.service.runs.cancel(running.run_id, { action: "rollback" });
    expect((await runtime.service.threads.getState(thread.thread_id)).values).toEqual({
      value: "forked",
    });
    expect(await embedded.deps.store.runs.get(running.run_id)).toBeNull();
  } finally {
    await embedded.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
