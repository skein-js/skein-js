import { describe, expect, it } from "vitest";

import { collect, createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { createProtocolServiceFromContext } from "../service.js";

async function serviceWithAssistants(deps = createFixtureDeps()) {
  const service = createProtocolServiceFromContext(createContext(deps));
  await service.assistants.registerGraphAssistants();
  return service;
}

describe("thread stream service — interrupt / resume", () => {
  it("streams a run, interrupts, then resumes with a command back to idle", async () => {
    const service = await serviceWithAssistants();
    const thread = await service.threads.create();

    const started = await service.threadStream.stream(thread.thread_id, {
      assistant_id: "interrupting",
      input: {},
    });
    await collect(started.frames);

    expect((await service.threads.get(thread.thread_id)).status).toBe("interrupted");

    const resumed = await service.threadStream.command(thread.thread_id, { resume: "yes" });
    await collect(resumed.frames);

    const thread2 = await service.threads.get(thread.thread_id);
    expect(thread2.status).toBe("idle");
    expect(thread2.values).toEqual({ value: "resumed: yes" });
  });

  it("409s a command on a thread that is not interrupted", async () => {
    const service = await serviceWithAssistants();
    const thread = await service.threads.create();
    await expect(
      service.threadStream.command(thread.thread_id, { resume: "x" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("joins the current run's stream on an existing thread", async () => {
    const service = await serviceWithAssistants();
    const thread = await service.threads.create();
    const started = await service.threadStream.stream(thread.thread_id, {
      assistant_id: "echo",
      input: { value: "hi" },
    });
    await collect(started.frames);

    const joined = await service.threadStream.joinStream(thread.thread_id, 0);
    expect(joined.runId).toBe(started.runId);
    expect((await collect(joined.frames)).length).toBeGreaterThan(0);
  });
});
