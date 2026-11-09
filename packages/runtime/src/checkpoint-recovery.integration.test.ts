import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { startPostgres, startRedis, type StartedResource } from "@skein-js/test-support";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { buildRecoveryGraph } from "./__fixtures__/recovery-graph.js";
import { embedPostgresGraphs, type EmbeddedPostgresRuntime } from "./embed-postgres-graphs.js";

let postgres: StartedResource;
let redis: StartedResource;

beforeAll(async () => {
  [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([postgres?.stop(), redis?.stop()]);
});

it("continues a killed Redis worker from its committed Postgres checkpoint without replaying input", async () => {
  const graph = buildRecoveryGraph(() => embedded.deps);
  const embedded: EmbeddedPostgresRuntime = await embedPostgresGraphs(
    { recovery: graph },
    { postgresUri: postgres.url, redisUri: redis.url },
  );
  const runtime = createProtocolRuntime(embedded.deps, { scheduler: { enabled: false } });
  await runtime.service.assistants.registerGraphAssistants();
  const thread = await runtime.service.threads.create();
  const run = await runtime.service.runs.createBackground(thread.thread_id, {
    assistant_id: "recovery",
    input: { total: 1 },
    durability: "sync",
  });
  const child = fork(
    fileURLToPath(new URL("./__fixtures__/recovery-worker.mjs", import.meta.url)),
    {
      env: { ...process.env, POSTGRES_URI: postgres.url, REDIS_URI: redis.url },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const frames = (async () => {
    const received = [];
    for await (const frame of embedded.deps.bus.subscribe(run.run_id)) received.push(frame);
    return received;
  })();
  try {
    expect((await once(child, "message", { signal: AbortSignal.timeout(20_000) }))[0]).toBe(
      "checkpointed",
    );
    expect((await embedded.deps.store.runs.getKwargs(run.run_id))?.durability).toBe("sync");
    expect((await runtime.service.threads.getState(thread.thread_id)).values).toEqual({
      total: 11,
      steps: ["first"],
    });
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    const checkpoint = await embedded.deps.checkpointer.getTuple({
      configurable: { thread_id: thread.thread_id },
    });
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.metadata).toMatchObject({ run_id: run.run_id });
    expect((await embedded.deps.store.runs.get(run.run_id))?.status).toBe("running");
    runtime.worker.start();
    await expect
      .poll(async () => (await embedded.deps.store.runs.get(run.run_id))?.status, {
        timeout: 95_000,
        interval: 250,
      })
      .toBe("success");
    const state = await runtime.service.threads.getState(thread.thread_id);
    expect(state.values).toEqual({ total: 111, steps: ["first", "second"] });
    expect(
      (await embedded.deps.store.store.get(["recovery-effects"], thread.thread_id))?.value,
    ).toEqual({ count: 1 });
    expect((await embedded.deps.store.runs.getKwargs(run.run_id))?.base_checkpoint_id).toBeNull();
    const received = await frames;
    const sequences = received.map((frame) => frame.seq);
    expect(sequences).toEqual([...new Set(sequences)].sort((left, right) => left - right));
    expect(received.at(-1)?.data).toEqual({ total: 111, steps: ["first", "second"] });
    // A settled run redelivered again is a no-op, including its external effect.
    const readRun = vi.spyOn(embedded.deps.store.runs, "get");
    await embedded.deps.queue.enqueue({ run_id: run.run_id, thread_id: thread.thread_id });
    await expect.poll(() => readRun.mock.calls.some(([id]) => id === run.run_id)).toBe(true);
    await runtime.worker.stop();
    readRun.mockRestore();
    expect(
      (await embedded.deps.store.store.get(["recovery-effects"], thread.thread_id))?.value,
    ).toEqual({ count: 1 });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
    await runtime.worker.stop();
    await embedded.deps.bus.close(run.run_id);
    await frames;
    await embedded.dispose();
  }
}, 120_000);
