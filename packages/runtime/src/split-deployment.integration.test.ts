import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import {
  createProtocolRuntime,
  type ProtocolHandlers,
  type ProtocolRequest,
} from "@skein-js/agent-protocol";
import type { Run, Thread } from "@skein-js/core";
import { startPostgres, startRedis, type StartedResource } from "@skein-js/test-support";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { splitAuth } from "./__fixtures__/split-auth.js";
import { buildSplitGraph } from "./__fixtures__/split-graph.js";
import { embedPostgresGraphs } from "./embed-postgres-graphs.js";

let postgres: StartedResource;
let redis: StartedResource;
beforeAll(async () => {
  [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
}, 120_000);
afterAll(async () => {
  await Promise.allSettled([postgres?.stop(), redis?.stop()]);
});

it("separates authorized API admission/streams from worker execution, cancellation, maintenance and shutdown", async () => {
  const embedded = await embedPostgresGraphs(
    { split: buildSplitGraph() },
    { postgresUri: postgres.url, redisUri: redis.url, overrides: { auth: splitAuth } },
  );
  const api = createProtocolRuntime(embedded.deps);
  await api.service.assistants.registerGraphAssistants();
  const expiredReads = vi.spyOn(embedded.deps.store.threads, "listExpired");
  // API owner does not start worker/maintenance. The child is the only consumer and loop owner.
  const child = fork(fileURLToPath(new URL("./__fixtures__/split-worker.mjs", import.meta.url)), {
    env: { ...process.env, POSTGRES_URI: postgres.url, REDIS_URI: redis.url },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const request = (body: unknown, params = {}, user = "alice"): ProtocolRequest => ({
    method: "POST",
    url: "http://localhost/",
    headers: { "x-user": user },
    params,
    query: {},
    body,
  });
  const json = async <T>(
    name: keyof ProtocolHandlers,
    body: unknown,
    params = {},
    user = "alice",
  ): Promise<T> => {
    const handler = api.handlers[name];
    if (!handler) throw new Error("Missing handler");
    const response = await handler(request(body, params, user));
    if (response.kind !== "json") throw new Error("Expected JSON");
    return response.body as T;
  };
  let stopped = false;
  try {
    expect((await once(child, "message", { signal: AbortSignal.timeout(20_000) }))[0]).toBe(
      "ready",
    );
    const thread = await json<Thread>("createThread", {});
    const run = await json<Run>(
      "createBackgroundRun",
      { assistant_id: "split", input: { value: "background", delay: 200 } },
      { thread_id: thread.thread_id },
    );
    await expect(
      json("getRun", undefined, { thread_id: thread.thread_id, run_id: run.run_id }, "bob"),
    ).rejects.toMatchObject({ status: 404 });
    const stream = await api.handlers.joinRunStream(
      request(undefined, { thread_id: thread.thread_id, run_id: run.run_id }),
    );
    if (stream.kind !== "sse") throw new Error("Expected SSE");
    const events: string[] = [];
    for await (const event of stream.events) events.push(event);
    expect(events.join("")).toContain(`"ownerPid":${child.pid}`);
    expect(events.join("")).toContain('"caller":"alice"');
    const replay = await api.handlers.joinRunStream({
      ...request(undefined, { thread_id: thread.thread_id, run_id: run.run_id }),
      headers: { "x-user": "alice", "last-event-id": "0" },
    });
    if (replay.kind !== "sse") throw new Error("Expected SSE");
    const rejoined: string[] = [];
    for await (const event of replay.events) rejoined.push(event);
    expect(rejoined.join("")).toContain("background");
    // Wait remains inline even with a separate worker consuming background work.
    expect(
      await json("createWaitRun", { assistant_id: "split", input: { value: "inline" } }),
    ).toMatchObject({ ownerPid: process.pid, caller: "alice" });
    const inlineThread = await json<Thread>("createThread", {});
    const inline = json("createWaitRun", {
      thread_id: inlineThread.thread_id,
      assistant_id: "split",
      input: { value: "inline-cancel", delay: 30_000 },
    });
    await expect
      .poll(
        async () =>
          (await embedded.deps.store.runs.latestForThread(inlineThread.thread_id))?.status,
      )
      .toBe("running");
    const inlineRun = await embedded.deps.store.runs.latestForThread(inlineThread.thread_id);
    child.send({ cancel: inlineRun!.run_id });
    await inline;
    expect((await embedded.deps.store.runs.get(inlineRun!.run_id))?.status).toBe("cancelled");
    const cancelled = await json<Run>(
      "createBackgroundRun",
      { assistant_id: "split", input: { value: "cancel", delay: 30_000 } },
      { thread_id: thread.thread_id },
    );
    await expect
      .poll(async () => (await embedded.deps.store.runs.get(cancelled.run_id))?.status)
      .toBe("running");
    await api.handlers.cancelRun(
      request(undefined, { thread_id: thread.thread_id, run_id: cancelled.run_id }),
    );
    await expect
      .poll(async () => (await embedded.deps.store.runs.get(cancelled.run_id))?.status)
      .toBe("cancelled");
    const draining = await json<Run>(
      "createBackgroundRun",
      { assistant_id: "split", input: { value: "shutdown", delay: 30_000 } },
      { thread_id: thread.thread_id },
    );
    await expect
      .poll(async () => (await embedded.deps.store.runs.get(draining.run_id))?.status)
      .toBe("running");
    const exit = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
    child.send("stop");
    await exit;
    stopped = true;
    expect(child.exitCode).toBe(0);
    expect((await embedded.deps.store.runs.get(draining.run_id))?.status).toBe("cancelled");
    expect(expiredReads).not.toHaveBeenCalled();
  } finally {
    if (!stopped && child.exitCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
    await api.worker.stop();
    await embedded.dispose();
  }
}, 45_000);
