// End-to-end coverage of the four `multitask_strategy` values against a busy thread, matching
// @langchain/langgraph-api: reject (422), enqueue (run behind), interrupt (stop keeping work),
// rollback (stop discarding work). A `slow` run holds the thread busy while the second run arrives.

import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { buildProtocolService, type ProtocolService } from "../service.js";

async function serviceWithAssistants() {
  const ctx = createContext(createFixtureDeps());
  const service = buildProtocolService(ctx);
  await service.assistants.registerGraphAssistants();
  return { ctx, service };
}

async function waitForStatus(
  service: ProtocolService,
  runId: string,
  status: string,
  timeoutMs = 3000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = await service.runs.get(runId).catch(() => null);
    if (run?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for run ${runId} to reach ${status}`);
}

// Start a long-running `slow` run inline and wait until it is actually executing (holding the thread).
async function startActiveRun(service: ProtocolService, threadId: string): Promise<string> {
  const { runId } = await service.runs.createStream({
    assistant_id: "slow",
    input: {},
    thread_id: threadId,
    stream_mode: "values",
  });
  await waitForStatus(service, runId, "running");
  return runId;
}

describe("multitask strategies", () => {
  it("reject: a busy thread rejects the second run with 422 and leaves the first running", async () => {
    const { service } = await serviceWithAssistants();
    const thread = await service.threads.create();
    const activeId = await startActiveRun(service, thread.thread_id);

    await expect(
      service.runs.createBackground(thread.thread_id, {
        assistant_id: "echo",
        input: { value: "hi" },
        multitask_strategy: "reject",
      }),
    ).rejects.toMatchObject({ status: 422, code: "thread_busy" });

    expect((await service.runs.get(activeId)).status).toBe("running");
  });

  it("enqueue: the second run waits for the active run, then runs to success", async () => {
    const { service } = await serviceWithAssistants();
    const thread = await service.threads.create();
    const activeId = await startActiveRun(service, thread.thread_id);

    const queued = await service.runs.createStream({
      assistant_id: "echo",
      input: { value: "hi" },
      thread_id: thread.thread_id,
      multitask_strategy: "enqueue",
    });
    // Behind the active run: still pending while it holds the thread.
    expect((await service.runs.get(queued.runId)).status).toBe("pending");

    // Free the thread; the enqueued run now executes.
    await service.runs.cancel(activeId);
    await waitForStatus(service, queued.runId, "success");
    expect((await service.runs.get(activeId)).status).toBe("cancelled");
  });

  it("interrupt: stops the active run (kept as interrupted), then runs the new one", async () => {
    const { service } = await serviceWithAssistants();
    const thread = await service.threads.create();
    const activeId = await startActiveRun(service, thread.thread_id);

    const next = await service.runs.createStream({
      assistant_id: "echo",
      input: { value: "hi" },
      thread_id: thread.thread_id,
      multitask_strategy: "interrupt",
    });

    // The displaced run is stopped and kept as `interrupted`; the new run runs to success.
    await waitForStatus(service, activeId, "interrupted");
    await waitForStatus(service, next.runId, "success");
    // The displaced run's row is preserved (interrupt keeps its work).
    expect((await service.runs.get(activeId)).status).toBe("interrupted");
  });

  it("rollback: discards the active run and its row, then runs the new one from the base state", async () => {
    const { service } = await serviceWithAssistants();
    const thread = await service.threads.create();
    const activeId = await startActiveRun(service, thread.thread_id);

    const next = await service.runs.createStream({
      assistant_id: "echo",
      input: { value: "hi" },
      thread_id: thread.thread_id,
      multitask_strategy: "rollback",
    });

    await waitForStatus(service, next.runId, "success");
    // The rolled-back run "never happened": its row is gone.
    await expect(service.runs.get(activeId)).rejects.toThrow();
    // The new run produced the expected state on a thread reverted to before the displaced run.
    expect((await service.threads.getState(thread.thread_id)).values).toEqual({
      value: "echo: hi",
    });
  });
});
