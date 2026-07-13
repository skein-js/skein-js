import type { RunFrame } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { MemoryRunEventBus, MemoryRunQueue } from "./memory-queue.js";

const frame = (seq: number): RunFrame => ({ seq, event: "values", data: { seq } });

async function collect(iterable: AsyncIterable<RunFrame>): Promise<RunFrame[]> {
  const out: RunFrame[] = [];
  for await (const f of iterable) out.push(f);
  return out;
}

describe("MemoryRunQueue", () => {
  it("dequeues in FIFO order and returns null when empty", async () => {
    const queue = new MemoryRunQueue();
    await queue.enqueue({ run_id: "1", thread_id: "t" });
    await queue.enqueue({ run_id: "2", thread_id: "t" });

    expect((await queue.dequeue())?.run_id).toBe("1");
    expect((await queue.dequeue())?.run_id).toBe("2");
    expect(await queue.dequeue()).toBeNull();
  });
});

describe("MemoryRunEventBus", () => {
  it("replays buffered frames to a late subscriber, then completes on close", async () => {
    const bus = new MemoryRunEventBus();
    await bus.publish("r", frame(1));
    await bus.publish("r", frame(2));
    await bus.close("r");

    expect((await collect(bus.subscribe("r"))).map((f) => f.seq)).toEqual([1, 2]);
  });

  it("honors afterSeq so a reconnecting client skips what it already saw", async () => {
    const bus = new MemoryRunEventBus();
    for (const seq of [1, 2, 3]) await bus.publish("r", frame(seq));
    await bus.close("r");

    expect((await collect(bus.subscribe("r", 2))).map((f) => f.seq)).toEqual([3]);
  });

  it("live-tails frames published after the subscription starts", async () => {
    const bus = new MemoryRunEventBus();
    const collected = collect(bus.subscribe("r"));

    await bus.publish("r", frame(1));
    await bus.publish("r", frame(2));
    await bus.close("r");

    expect((await collected).map((f) => f.seq)).toEqual([1, 2]);
  });

  it("evicts the oldest closed runs beyond the retention cap (bounded memory)", async () => {
    const bus = new MemoryRunEventBus({ maxRetainedRuns: 2 });
    for (const runId of ["a", "b", "c"]) {
      await bus.publish(runId, frame(1));
      await bus.close(runId);
    }
    // "a"'s buffer was dropped (oldest beyond the cap of 2): a late join replays nothing and
    // completes at once (closed tombstone — no hang). "b"/"c" still replay their buffered frame.
    expect(await collect(bus.subscribe("a"))).toEqual([]);
    expect((await collect(bus.subscribe("b"))).map((f) => f.seq)).toEqual([1]);
    expect((await collect(bus.subscribe("c"))).map((f) => f.seq)).toEqual([1]);
  });
});
