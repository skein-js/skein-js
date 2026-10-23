import { runThreadEventBusConformance } from "@skein-js/test-support";
import { describe, expect, it } from "vitest";

import { MemoryThreadEventBus } from "./memory-thread-event-bus.js";

runThreadEventBusConformance("memory", () => new MemoryThreadEventBus());

describe("thread event retention", () => {
  it("allows a fresh subscription after payload eviction while rejecting an expired explicit cursor", async () => {
    const bus = new MemoryThreadEventBus();
    for (let index = 0; index < 51; index++)
      await bus.publish(`thread-${index}`, {
        kind: "run",
        runId: "run",
        frame: { seq: 0, event: "values", data: {} },
      });
    expect(await bus.replayCursor("thread-0")).toBe(1);
    await expect(bus.subscribe("thread-0", 0)[Symbol.asyncIterator]().next()).rejects.toMatchObject(
      { code: "thread_cursor_expired" },
    );
    const iterator = bus.subscribe("thread-0")[Symbol.asyncIterator]();
    const next = iterator.next();
    await bus.publish("thread-0", {
      kind: "run",
      runId: "next",
      frame: { seq: 0, event: "values", data: {} },
    });
    expect((await next).value.seq).toBe(2);
    await iterator.return?.();
  });
  it("reports a replay gap after payload trimming without resetting its sequence", async () => {
    const bus = new MemoryThreadEventBus();
    for (let i = 0; i < 10_001; i++)
      await bus.publish("bounded", {
        kind: "run",
        runId: "r",
        frame: { seq: i, event: "values", data: {} },
      });
    await expect(bus.subscribe("bounded", 0)[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "thread_cursor_expired",
    });
    const iterator = bus.subscribe("bounded", 10_000)[Symbol.asyncIterator]();
    expect((await iterator.next()).value.seq).toBe(10_001);
    await iterator.return?.();
  });
});
