import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { createProtocolServiceFromContext } from "../service.js";

async function readEvent(iterator: AsyncIterator<string>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const frame = await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Expected a thread stream event")), 2000);
      }),
    ]);
    expect(frame.done).toBe(false);
    const value = String(frame.value);
    return {
      id: Number(/^id: (\d+)/m.exec(value)![1]),
      event: /^event: (.+)$/m.exec(value)![1],
      data: JSON.parse(/^data: (.+)$/m.exec(value)![1]!) as Record<string, unknown>,
    };
  } finally {
    clearTimeout(timer);
  }
}

describe("official thread stream categories", () => {
  it.each(["throwing", "interrupting"])(
    "emits completion metadata for a %s run",
    async (assistant) => {
      const deps = createFixtureDeps();
      const service = createProtocolServiceFromContext(createContext(deps));
      await service.assistants.registerGraphAssistants();
      const thread = await service.threads.create();
      const controller = new AbortController();
      const iterator = (
        await service.threadStream.follow!(
          thread.thread_id,
          ["lifecycle"],
          undefined,
          controller.signal,
        )
      )[Symbol.asyncIterator]();
      try {
        await iterator.next();
        const reading = readEvent(iterator);
        const run = await service.runs.createWait({
          thread_id: thread.thread_id,
          assistant_id: assistant,
          input: { value: "stop" },
        });
        expect(await reading).toMatchObject({
          event: "metadata",
          data: { run_id: run.runId, attempt: 1 },
        });
        expect(await readEvent(iterator)).toMatchObject({
          event: "metadata",
          data: { run_id: run.runId, status: "run_done" },
        });
      } finally {
        controller.abort();
        await iterator.return?.();
      }
    },
  );
  it("emits upstream metadata boundaries and full state snapshots across turns", async () => {
    const deps = createFixtureDeps();
    const service = createProtocolServiceFromContext(createContext(deps));
    await service.assistants.registerGraphAssistants();
    const thread = await service.threads.create();
    const controller = new AbortController();
    const iterator = (
      await service.threadStream.follow!(
        thread.thread_id,
        ["lifecycle", "state_update"],
        undefined,
        controller.signal,
      )
    )[Symbol.asyncIterator]();
    try {
      expect((await iterator.next()).value).toContain(": subscribed");
      let cursor = 0;
      for (const value of ["first", "second"]) {
        const reading = readEvent(iterator);
        const run = await service.runs.createWait({
          thread_id: thread.thread_id,
          assistant_id: "echo",
          input: { value },
        });
        const started = await reading;
        const done = await readEvent(iterator);
        const updated = await readEvent(iterator);
        expect(started).toMatchObject({
          event: "metadata",
          data: { run_id: run.runId, attempt: 1 },
        });
        expect(done).toMatchObject({
          event: "metadata",
          data: { status: "run_done", run_id: run.runId },
        });
        expect(updated).toMatchObject({
          event: "state_update",
          data: {
            thread_id: thread.thread_id,
            state: {
              values: { value: `echo: ${value}` },
              next: [],
              tasks: [],
              checkpoint: { thread_id: thread.thread_id },
            },
          },
        });
        expect(started.id).toBeGreaterThan(cursor);
        expect(done.id).toBeGreaterThan(started.id);
        expect(updated.id).toBeGreaterThan(done.id);
        cursor = updated.id;
      }
    } finally {
      controller.abort();
      await iterator.return?.();
    }
  });

  it("replays the state of each completed run rather than the current thread tip", async () => {
    const deps = createFixtureDeps();
    const service = createProtocolServiceFromContext(createContext(deps));
    await service.assistants.registerGraphAssistants();
    const thread = await service.threads.create();
    for (const value of ["older", "newer"])
      await service.runs.createWait({
        thread_id: thread.thread_id,
        assistant_id: "echo",
        input: { value },
      });
    const controller = new AbortController();
    const iterator = (
      await service.threadStream.follow!(thread.thread_id, ["state_update"], 0, controller.signal)
    )[Symbol.asyncIterator]();
    try {
      await iterator.next();
      expect((await readEvent(iterator)).data).toMatchObject({
        state: { values: { value: "echo: older" } },
      });
      expect((await readEvent(iterator)).data).toMatchObject({
        state: { values: { value: "echo: newer" } },
      });
    } finally {
      controller.abort();
      await iterator.return?.();
    }
  });

  it("publishes direct state updates using the same upstream envelope", async () => {
    const deps = createFixtureDeps();
    const service = createProtocolServiceFromContext(createContext(deps));
    await service.assistants.registerGraphAssistants();
    const thread = await service.threads.create();
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "before" },
    });
    const controller = new AbortController();
    const iterator = (
      await service.threadStream.follow!(
        thread.thread_id,
        ["state_update"],
        undefined,
        controller.signal,
      )
    )[Symbol.asyncIterator]();
    try {
      await iterator.next();
      const reading = readEvent(iterator);
      await service.threads.updateState(thread.thread_id, { values: { value: "manual" } });
      expect(await reading).toMatchObject({
        event: "state_update",
        data: { thread_id: thread.thread_id, state: { values: { value: "manual" } } },
      });
    } finally {
      controller.abort();
      await iterator.return?.();
    }
  });
});
