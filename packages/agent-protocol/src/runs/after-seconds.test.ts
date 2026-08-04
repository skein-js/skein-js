// `after_seconds` on run create — the SDK's "schedule a future run".
//
// A background run rides the queue's own delay (BullMQ's delayed set on Redis); an inline run is held
// by the server with the caller's connection open. Asserted at the service layer against a recording
// queue, because what matters here is *what the run service asks the queue for* — the delay's actual
// timing is the queue drivers' contract and is pinned by the shared queue conformance suite.

import type { EnqueueOptions, QueuedRun } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { createProtocolServiceFromContext } from "../service.js";

/** Records what was enqueued and with which options, and never delivers — nothing should execute. */
function recordingQueue() {
  const enqueued: Array<{ run: QueuedRun; options?: EnqueueOptions }> = [];
  return {
    enqueued,
    queue: {
      enqueue: async (run: QueuedRun, options?: EnqueueOptions) => {
        enqueued.push({ run, options });
      },
      consume: () => ({ close: async () => undefined }),
    },
  };
}

async function harness() {
  const { enqueued, queue } = recordingQueue();
  const deps = { ...createFixtureDeps(), queue };
  const service = createProtocolServiceFromContext(createContext(deps));
  await service.assistants.registerGraphAssistants();
  return { deps, service, enqueued };
}

const run = { assistant_id: "echo", input: { value: "hi" } } as const;

describe("after_seconds", () => {
  it("hands the delay to the queue on a thread-scoped background run", async () => {
    const { service, enqueued } = await harness();
    const thread = await service.threads.create();

    await service.runs.createBackground(thread.thread_id, { ...run, after_seconds: 30 });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.options).toEqual({ delayMs: 30_000 });
  });

  it("hands the delay to the queue on a stateless background run", async () => {
    const { service, enqueued } = await harness();

    await service.runs.createStatelessBackground({ ...run, after_seconds: 5 });

    expect(enqueued[0]?.options).toEqual({ delayMs: 5000 });
  });

  it("enqueues with no delay when after_seconds is absent or zero", async () => {
    const { service, enqueued } = await harness();
    const thread = await service.threads.create();

    await service.runs.createBackground(thread.thread_id, run);
    await service.runs.createStatelessBackground({ ...run, after_seconds: 0 });

    expect(enqueued[0]?.options).toBeUndefined();
    expect(enqueued[1]?.options).toBeUndefined();
  });

  it("holds an inline wait run for the delay before executing it", async () => {
    // Real timing, one second, because the point is that the server actually waits — there is no queue
    // on this path to ask about, only the caller's held connection.
    const { service } = await harness();

    const startedAt = Date.now();
    const { result } = await service.runs.createWait({ ...run, after_seconds: 1 });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(result).toBeDefined();
  });

  it("returns a stream immediately, deferring only execution", async () => {
    // The run row and its ids exist before the delay, so the transport can send `Content-Location` and
    // start heartbeating rather than holding the response open for `after_seconds` with no headers.
    const { service } = await harness();

    const startedAt = Date.now();
    const started = await service.runs.createStream({ ...run, after_seconds: 1 });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(started.runId).toBeTruthy();
    expect(started.threadId).toBeTruthy();
  });

  it("leaves the run pending — so it holds its thread against multitask reject", async () => {
    // A delayed run is inflight from the moment it is created: the thread has work scheduled on it, so
    // a second run under the default `reject` is refused rather than racing it. Documented behaviour,
    // pinned here because it is the surprising half of `after_seconds`.
    const { deps, service, enqueued } = await harness();
    const thread = await service.threads.create();

    await service.runs.createBackground(thread.thread_id, { ...run, after_seconds: 60 });

    const runId = enqueued[0]?.run.run_id as string;
    expect((await deps.store.runs.get(runId))?.status).toBe("pending");
    expect(await deps.store.runs.hasActiveRun(thread.thread_id)).toBe(true);

    await expect(service.runs.createBackground(thread.thread_id, run)).rejects.toMatchObject({
      status: 422,
    });
  });
});
