import type { Run } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { collect, createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { resolveDeps } from "../deps.js";
import { buildProtocolService } from "../service.js";

import { RunControlRegistry } from "./cancellation.js";
import { executeRun } from "./run-engine.js";
import { createRunWorker } from "./run-worker.js";

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function serviceWithAssistants(deps = createFixtureDeps()) {
  const service = buildProtocolService(createContext(deps));
  await service.assistants.registerGraphAssistants();
  return service;
}

describe("cancellation", () => {
  it("cancels a running stream: terminal error, thread freed, stream completes", async () => {
    const service = await serviceWithAssistants();
    const { runId, frames } = await service.runs.createStream({ assistant_id: "slow", input: {} });
    await tick();

    const cancelled = await service.runs.cancel(runId);
    expect(cancelled.status).toBe("error");

    await collect(frames); // completes once the engine closes the bus
    const run = await service.runs.get(runId);
    expect(run.status).toBe("error");
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
    const service = buildProtocolService(ctx);
    await service.assistants.registerGraphAssistants();
    const thread = await service.threads.create();
    const run = await service.runs.createBackground(thread.thread_id, {
      assistant_id: "echo",
      input: {},
    });

    const cancelled = await service.runs.cancel(run.run_id);
    expect(cancelled.status).toBe("error");

    // The job is still queued, but terminal — a running worker consumes and skips it (stays error).
    const worker = createRunWorker(ctx);
    worker.start();
    try {
      await tick(80);
      expect((await service.runs.get(run.run_id)).status).toBe("error");
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
