import { expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createProtocolRuntime } from "../runtime.js";

it.each(["native", "service", "displacement"])(
  "retains native receipts after %s rollback cleanup",
  async (operation) => {
    const runtime = createProtocolRuntime(createFixtureDeps(), { scheduler: { enabled: false } });
    try {
      await runtime.service.assistants.registerGraphAssistants();
      const client = runtime.createNativeClient({
        sourceId: "rollback",
        allowedAssistants: ["slow", "echo"],
      });
      const first = await client.start(
        { assistant_id: "slow", input: {} },
        { idempotencyKey: "first" },
      );
      runtime.worker.start();
      await expect.poll(async () => (await client.getRun(first.runId)).status).toBe("running");
      if (operation === "native")
        await client.cancel(first.runId, { action: "rollback", wait: true });
      else if (operation === "service")
        await runtime.service.runs.cancel(first.runId, { action: "rollback", wait: true });
      else {
        const second = await client.start({
          assistant_id: "echo",
          thread_id: first.threadId,
          input: { value: "after" },
          multitask_strategy: "rollback",
        });
        await expect.poll(async () => (await client.getRun(second.runId)).status).toBe("success");
      }
      expect(await client.getReceipt("first")).toEqual(first);
      expect((await client.getRun(first.runId)).status).toBe("cancelled");
    } finally {
      await runtime.worker.stop();
    }
  },
);
