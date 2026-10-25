import { expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { resolveDeps } from "../deps.js";

import { verifyA2aResume } from "./a2a-origin.js";

it("preserves infrastructure failures from shared resume validation", async () => {
  const deps = resolveDeps(createFixtureDeps());
  const outage = new Error("checkpoint storage is unavailable");
  vi.spyOn(deps.checkpointer, "getTuple").mockRejectedValue(outage);
  await expect(
    verifyA2aResume(deps, "thread", "answer", {
      expectedRunId: "previous",
      checkpoint: {
        thread_id: "thread",
        checkpoint_ns: "",
        checkpoint_id: "expected",
        checkpoint_map: null,
      },
    }),
  ).rejects.toBe(outage);
});

it("retains the A2A-specific conflict for a stale resume target", async () => {
  await expect(
    verifyA2aResume(resolveDeps(createFixtureDeps()), "thread", "answer", {
      expectedRunId: "previous",
      checkpoint: {
        thread_id: "thread",
        checkpoint_ns: "",
        checkpoint_id: "expected",
        checkpoint_map: null,
      },
    }),
  ).rejects.toMatchObject({
    status: 409,
    message: "A2A task no longer owns the interrupted checkpoint.",
  });
});
