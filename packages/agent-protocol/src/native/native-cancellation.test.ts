import type { RunAbortChannel } from "@skein-js/core";
import { expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { createRunWorker } from "../runs/run-worker.js";
import { createProtocolRuntime } from "../runtime.js";
import { createProtocolServiceFromContext } from "../service.js";

it("keeps failed cancellation publications recoverable until a successful retry", async () => {
  let offset = 0;
  let connected = false;
  const requestAbort = vi.fn(async () => {
    if (!connected) throw new Error("pubsub disconnected");
  });
  const channel: RunAbortChannel = {
    requestAbort,
    subscribe: () => ({ close: async () => undefined }),
  };
  const deps = createFixtureDeps({
    abortChannel: channel,
    clock: () => new Date(Date.now() + offset),
  });
  const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
  try {
    await runtime.service.assistants.registerGraphAssistants();
    const client = runtime.createNativeClient({ sourceId: "retry", allowedAssistants: ["slow"] });
    const receipt = await client.start({ assistant_id: "slow", input: {} });
    await client.cancel(receipt.runId);
    runtime.worker.start();
    await expect.poll(() => requestAbort.mock.calls.length).toBeGreaterThanOrEqual(2);
    // No successful publication: even if the process dies now, a new claimant can retry the intent.
    await runtime.worker.stop();
    offset = 60_000;
    const claims = await deps.store.admission!.claimDispatches({
      now: new Date(Date.now() + offset).toISOString(),
      leaseUntil: new Date(Date.now() + offset + 30_000).toISOString(),
    });
    expect(claims).toMatchObject([{ runId: receipt.runId, kind: "cancel" }]);
    connected = true;
    offset += 60_000;
    runtime.worker.start();
    await expect.poll(() => requestAbort.mock.calls.length).toBeGreaterThanOrEqual(3);
    await runtime.worker.stop();
    offset += 60_000;
    expect(
      await deps.store.admission!.claimDispatches({
        now: new Date(Date.now() + offset).toISOString(),
        leaseUntil: new Date(Date.now() + offset + 30_000).toISOString(),
      }),
    ).toEqual([]);
  } finally {
    await runtime.worker.stop();
  }
});

it.each(["native", "service"])(
  "stops a %s run when published cancellation misses its executor",
  async (source) => {
    // A successful Redis publish with zero subscribers cannot be distinguished from delivery.
    const requestAbort = vi.fn(async () => undefined);
    const channel: RunAbortChannel = {
      requestAbort,
      subscribe: () => ({ close: async () => undefined }),
    };
    const deps = createFixtureDeps({ abortChannel: channel });
    const owner = createContext(deps);
    const service = createProtocolServiceFromContext(owner);
    const executor = createRunWorker(owner); // No admission recovery loop on the owner.
    const receiver = createProtocolRuntime(deps, { scheduler: { enabled: false } });
    let runId: string | undefined;
    try {
      await service.assistants.registerGraphAssistants();
      const client = receiver.createNativeClient({
        sourceId: "cancel",
        allowedAssistants: ["slow"],
      });
      runId =
        source === "native"
          ? (await client.start({ assistant_id: "slow", input: {} })).runId
          : (
              await service.runs.createBackground((await service.threads.create()).thread_id, {
                assistant_id: "slow",
                input: {},
              })
            ).run_id;
      const id = runId;
      executor.start();
      await expect.poll(async () => (await deps.store.runs.get(id))?.status).toBe("running");
      const control = owner.control.register(id);
      const cancelled = await client.cancel(id, { idempotencyKey: "cancel" });
      expect(cancelled.stopped).toBe(false);
      await expect.poll(() => control.signal.aborted, { timeout: 3000 }).toBe(true);
      expect(control.reason.current).toBe("cancel");
      // The observer aborts locally, never forwarding a second message onto the broken channel.
      expect(requestAbort).toHaveBeenCalledTimes(1);
      owner.control.clear(id);
      expect((await client.getRun(id)).status).toBe("cancelled");
    } finally {
      if (runId) owner.control.applyRemoteAbort(runId, "cancel");
      await executor.stop();
      await receiver.worker.stop();
    }
  },
);
