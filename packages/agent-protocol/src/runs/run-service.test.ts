import { describe, expect, it } from "vitest";

import { collect, createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { buildProtocolService } from "../service.js";

async function serviceWithAssistants(deps = createFixtureDeps()) {
  const ctx = createContext(deps);
  const service = buildProtocolService(ctx);
  await service.assistants.registerGraphAssistants();
  return { ctx, service };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

describe("run service", () => {
  it("createWait runs to completion and returns the final values", async () => {
    const { service } = await serviceWithAssistants();
    const values = await service.runs.createWait({
      assistant_id: "echo",
      input: { value: "hi" },
    });
    expect(values).toEqual({ value: "echo: hi" });
  });

  it("createStream yields frames and ends the run in success", async () => {
    const { service } = await serviceWithAssistants();
    const { runId, frames } = await service.runs.createStream({
      assistant_id: "echo",
      input: { value: "yo" },
      stream_mode: "values",
    });
    const collected = await collect(frames);
    expect(collected.length).toBeGreaterThan(0);
    expect((await service.runs.get(runId)).status).toBe("success");
  });

  it("createBackground enqueues a pending run without executing it", async () => {
    const deps = createFixtureDeps();
    const { service } = await serviceWithAssistants(deps);
    const thread = await service.threads.create();
    const run = await service.runs.createBackground(thread.thread_id, {
      assistant_id: "echo",
      input: {},
    });

    // createBackground does not run inline — the run is left pending for a worker.
    expect(run.status).toBe("pending");

    // The exact QueuedRun is on the queue: a consumer receives it.
    const received: unknown[] = [];
    const consumer = deps.queue.consume(async (queued) => {
      received.push(queued);
    });
    await waitFor(() => received.length === 1);
    await consumer.close();
    expect(received[0]).toEqual({ run_id: run.run_id, thread_id: thread.thread_id });
  });

  it("rejects a second concurrent run on the same thread with a 409", async () => {
    const { service } = await serviceWithAssistants();
    const thread = await service.threads.create();
    await service.runs.createBackground(thread.thread_id, { assistant_id: "echo", input: {} });

    await expect(
      service.runs.createBackground(thread.thread_id, { assistant_id: "echo", input: {} }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("404s an unknown assistant or thread", async () => {
    const { service } = await serviceWithAssistants();
    await expect(
      service.runs.createWait({ assistant_id: "ghost", input: {} }),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.runs.get("no-run")).rejects.toMatchObject({ status: 404 });
  });

  it("does not create an orphan thread when the assistant is invalid", async () => {
    const deps = createFixtureDeps();
    const { service } = await serviceWithAssistants(deps);
    const before = (await deps.store.threads.list()).length;
    await expect(
      service.runs.createWait({ assistant_id: "ghost", input: {} }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await deps.store.threads.list()).length).toBe(before);
  });

  it("clears a prior error from thread metadata once a later run succeeds", async () => {
    const { service } = await serviceWithAssistants();
    const thread = await service.threads.create();

    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "throwing",
      input: {},
    });
    const errored = await service.threads.get(thread.thread_id);
    expect(errored.status).toBe("error");
    expect((errored.metadata as { error?: unknown }).error).toBeDefined();

    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
    });
    const healed = await service.threads.get(thread.thread_id);
    expect(healed.status).toBe("idle");
    expect((healed.metadata as { error?: unknown }).error).toBeUndefined();
  });

  it("stamps the run's graph_id/assistant_id onto the thread so it is searchable by graph", async () => {
    const deps = createFixtureDeps();
    const { service } = await serviceWithAssistants(deps);

    await service.runs.createWait({ assistant_id: "echo", input: { value: "hi" } });

    // The thread carries the graph/assistant that ran on it (LangGraph-compatible metadata stamp).
    const [thread] = await deps.store.threads.list();
    expect(thread?.metadata).toMatchObject({ graph_id: "echo", assistant_id: "echo" });

    // And it is now returned by a metadata search filtering on graph_id.
    const byGraph = await deps.store.threads.search({ metadata: { graph_id: "echo" } });
    expect(byGraph.map((t) => t.thread_id)).toEqual([thread?.thread_id]);
  });

  it("stamps the graph onto a background run's thread without executing it", async () => {
    const deps = createFixtureDeps();
    const { service } = await serviceWithAssistants(deps);
    const created = await service.threads.create({ metadata: { user: "alice" } });

    await service.runs.createBackground(created.thread_id, { assistant_id: "echo", input: {} });

    // The stamp merges — pre-existing user metadata survives alongside graph_id/assistant_id.
    const stamped = await service.threads.get(created.thread_id);
    expect(stamped.metadata).toMatchObject({
      user: "alice",
      graph_id: "echo",
      assistant_id: "echo",
    });
  });

  it("join replays a finished run's frames from the buffer", async () => {
    const { service } = await serviceWithAssistants();
    const { runId, frames } = await service.runs.createStream({ assistant_id: "echo", input: {} });
    await collect(frames); // let the run finish

    const replay = await collect(await service.runs.join(runId, 0));
    expect(replay.length).toBeGreaterThan(0);
  });
});
