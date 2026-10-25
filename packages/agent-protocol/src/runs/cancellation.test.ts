import type { Run } from "@skein-js/core";
import { describe, expect, it, vi } from "vitest";

import { collect, createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { resolveDeps } from "../deps.js";
import { createProtocolServiceFromContext } from "../service.js";

import { RunControlRegistry } from "./cancellation.js";
import { executeRun } from "./run-engine.js";
import { createRunWorker } from "./run-worker.js";

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function serviceWithAssistants(deps = createFixtureDeps()) {
  const service = createProtocolServiceFromContext(createContext(deps));
  await service.assistants.registerGraphAssistants();
  return service;
}

describe("cancellation", () => {
  it("stops rollback cancellation when its execution lease is lost during the checkpoint read", async () => {
    const lost = new AbortController();
    const release = vi.fn(async () => undefined);
    const deps = createFixtureDeps({
      threadExecutionGate: { acquire: async () => ({ signal: lost.signal, release }) },
    });
    const service = await serviceWithAssistants(deps);
    const thread = await service.threads.create();
    const run = await deps.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      kwargs: { base_checkpoint_id: "base" },
    });
    vi.spyOn(deps.checkpointer, "list").mockImplementation(async function* (config) {
      if (config.configurable?.["thread_id"] === thread.thread_id) {
        lost.abort(new Error("rollback lease lost"));
        yield { config: { configurable: {} }, checkpoint: { id: "base" } };
      }
    });
    const erase = vi.spyOn(deps.checkpointer, "deleteThread");
    const put = vi.spyOn(deps.checkpointer, "put");
    expect((await service.runs.cancel(run.run_id, { action: "rollback", wait: true })).status).toBe(
      "cancelled",
    );
    expect(erase).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(await deps.store.runs.get(run.run_id)).not.toBeNull();
    expect(release).toHaveBeenCalledOnce();
  });
  it("cancels a running stream: terminal cancelled, thread freed, stream completes", async () => {
    const service = await serviceWithAssistants();
    const { runId, frames } = await service.runs.createStream({ assistant_id: "slow", input: {} });
    await tick();

    const cancelled = await service.runs.cancel(runId);
    expect(cancelled.status).toBe("cancelled");

    await collect(frames); // completes once the engine closes the bus
    const run = await service.runs.get(runId);
    expect(run.status).toBe("cancelled");
    expect((await service.threads.get(run.thread_id)).status).toBe("idle");
  });

  it("is a no-op on an already-finished run", async () => {
    const service = await serviceWithAssistants();
    const { runId, frames } = await service.runs.createStream({ assistant_id: "echo", input: {} });
    await collect(frames);

    const cancelled = await service.runs.cancel(runId);
    expect(cancelled.status).toBe("success");
  });

  it("cancels a pending background run so the worker skips it", async () => {
    const deps = createFixtureDeps();
    const ctx = createContext(deps);
    const service = createProtocolServiceFromContext(ctx);
    await service.assistants.registerGraphAssistants();
    const thread = await service.threads.create();
    const run = await service.runs.createBackground(thread.thread_id, {
      assistant_id: "echo",
      input: {},
    });

    const cancelled = await service.runs.cancel(run.run_id);
    expect(cancelled.status).toBe("cancelled");

    // The job is still queued, but terminal — a running worker consumes and skips it (stays cancelled).
    const worker = createRunWorker(ctx);
    worker.start();
    try {
      await tick(80);
      expect((await service.runs.get(run.run_id)).status).toBe("cancelled");
    } finally {
      await worker.stop();
    }
  });

  it("times out a run that overruns runTimeoutMs", async () => {
    const deps = resolveDeps(createFixtureDeps({ runTimeoutMs: 40 }));
    const assistant = await deps.store.assistants.create({
      graph_id: "slow",
      assistant_id: "slow",
    });
    const thread = await deps.store.threads.create();
    const run: Run = await deps.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: assistant.assistant_id,
      status: "pending",
    });
    const control = new RunControlRegistry().register(run.run_id);

    const outcome = await executeRun(deps, { run, kwargs: { input: {} }, control });
    expect(outcome.status).toBe("timeout");
    expect((await deps.store.threads.get(thread.thread_id))?.status).toBe("error");
  });
});
