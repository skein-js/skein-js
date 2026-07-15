import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import type { Logger } from "../deps.js";
import { buildProtocolService } from "../service.js";

import { createRunWorker } from "./run-worker.js";

/** A logger that records every `info` call's message + meta for assertions. */
function capturingLogger(): Logger & { infos: { message: string; meta?: unknown }[] } {
  const infos: { message: string; meta?: unknown }[] = [];
  return {
    infos,
    debug: () => {},
    info: (message, meta) => infos.push({ message, meta }),
    warn: () => {},
    error: () => {},
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

describe("run worker", () => {
  it("dequeues a background run and executes it to success", async () => {
    const deps = createFixtureDeps();
    const ctx = createContext(deps);
    const service = buildProtocolService(ctx);
    await service.assistants.registerGraphAssistants();
    const worker = createRunWorker(ctx);
    worker.start();
    try {
      const thread = await service.threads.create();
      const run = await service.runs.createBackground(thread.thread_id, {
        assistant_id: "echo",
        input: { value: "hi" },
      });
      await waitFor(async () => (await service.runs.get(run.run_id)).status === "success");
      expect((await service.threads.get(thread.thread_id)).values).toEqual({ value: "echo: hi" });
    } finally {
      await worker.stop();
    }
  });

  it("logs a background-run lifecycle summary through the injected logger", async () => {
    const logger = capturingLogger();
    const deps = createFixtureDeps({ logger });
    const ctx = createContext(deps);
    const service = buildProtocolService(ctx);
    await service.assistants.registerGraphAssistants();
    const worker = createRunWorker(ctx);
    worker.start();
    try {
      const thread = await service.threads.create();
      const run = await service.runs.createBackground(thread.thread_id, {
        assistant_id: "echo",
        input: { value: "hi" },
      });
      await waitFor(async () => logger.infos.some((i) => i.message === "Background run succeeded"));

      const summary = logger.infos.find((i) => i.message === "Background run succeeded");
      expect(summary?.meta).toMatchObject({ run_id: run.run_id, run_attempt: 1 });
      expect(summary?.meta).toHaveProperty("run_created_at");
      expect(summary?.meta).toHaveProperty("run_exec_ms");
      expect(summary?.meta).toHaveProperty("run_queue_ms");
    } finally {
      await worker.stop();
    }
  });

  it("skips a run that was cancelled while still queued", async () => {
    const deps = createFixtureDeps();
    const ctx = createContext(deps);
    const service = buildProtocolService(ctx);
    await service.assistants.registerGraphAssistants();
    const thread = await service.threads.create();
    const run = await service.runs.createBackground(thread.thread_id, {
      assistant_id: "slow",
      input: {},
    });
    await service.runs.cancel(run.run_id); // terminal before the worker even starts

    const worker = createRunWorker(ctx);
    worker.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await service.runs.get(run.run_id)).status).toBe("error");
    } finally {
      await worker.stop();
    }
  });

  it("stop() aborts an in-flight run past the grace deadline", async () => {
    const deps = createFixtureDeps();
    const ctx = createContext(deps);
    const service = buildProtocolService(ctx);
    await service.assistants.registerGraphAssistants();
    const worker = createRunWorker(ctx, { shutdownGraceMs: 30 });
    worker.start();

    const thread = await service.threads.create();
    const run = await service.runs.createBackground(thread.thread_id, {
      assistant_id: "slow",
      input: {},
    });
    await waitFor(async () => (await service.runs.get(run.run_id)).status === "running");

    await worker.stop(); // slow run never finishes on its own; must be aborted
    expect((await service.runs.get(run.run_id)).status).toBe("error");
  });
});
