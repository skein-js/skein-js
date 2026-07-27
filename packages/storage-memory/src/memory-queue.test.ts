import type { RunFrame } from "@skein-js/core";
import { runRunEventBusConformance, runRunQueueConformance } from "@skein-js/test-support";
import { describe, expect, it } from "vitest";

import { MemoryRunEventBus, MemoryRunQueue } from "./memory-queue.js";

// Prove the memory queue/bus satisfy the shared contract; `@skein-js/redis` runs this same suite.
runRunQueueConformance("memory", () => new MemoryRunQueue());
runRunEventBusConformance("memory", () => new MemoryRunEventBus());

const frame = (seq: number): RunFrame => ({ seq, event: "values", data: { seq } });

async function collect(iterable: AsyncIterable<RunFrame>): Promise<RunFrame[]> {
  const out: RunFrame[] = [];
  for await (const f of iterable) out.push(f);
  return out;
}

describe("MemoryRunQueue", () => {
  it("runs jobs up to the configured concurrency, no more", async () => {
    const queue = new MemoryRunQueue();
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const consumer = queue.consume(
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => release.push(resolve));
        active -= 1;
      },
      { concurrency: 2 },
    );
    for (const run_id of ["a", "b", "c"]) await queue.enqueue({ run_id, thread_id: "t" });

    // Only 2 run at once; the third waits behind them.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(peak).toBe(2);
    expect(release).toHaveLength(2);

    while (release.length) release.shift()?.(); // let the first two finish so the third starts
    await new Promise((resolve) => setTimeout(resolve, 50));
    while (release.length) release.shift()?.();
    await consumer.close();
    expect(peak).toBe(2);
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

describe("MemoryRunEventBus bounds", () => {
  // These assert on the bus's own counters rather than on process memory. A heap-size assertion in a
  // unit test is non-deterministic under Vitest's worker pool; the counters are exact.

  it("keeps no channel per run it has ever seen", async () => {
    const bus = new MemoryRunEventBus({ maxRetainedRuns: 5 });

    for (let run = 0; run < 5_000; run += 1) {
      await bus.publish(`run-${run}`, frame(1));
      await bus.close(`run-${run}`);
    }

    // Previously every run left a permanent entry behind: the map had `.set` and `.get` but no
    // `.delete` anywhere, and eviction only blanked the frame array. 5,000 runs meant 5,000 channels
    // for the life of the process.
    expect(bus.trackedChannelCount).toBe(5);
    expect(bus.bufferedFrameCount).toBe(5);
  });

  it("keeps a finished run replayable after its last subscriber detaches", async () => {
    // `GET /runs/{id}/stream` on a finished run is supported, and the common shape is a client that
    // streamed the run to completion and then re-joins. Releasing on detach would break exactly that.
    const bus = new MemoryRunEventBus();

    await bus.publish("r", frame(1));
    await bus.publish("r", frame(2));
    await bus.close("r");
    await collect(bus.subscribe("r"));

    expect((await collect(bus.subscribe("r"))).map((f) => f.seq)).toEqual([1, 2]);
  });

  it("still completes a late join to an evicted run instead of hanging", async () => {
    const bus = new MemoryRunEventBus({ maxRetainedRuns: 1 });
    await bus.publish("old", frame(1));
    await bus.close("old");
    await bus.publish("new", frame(1));
    await bus.close("new"); // pushes "old" out of the window, deleting its channel

    // The id is remembered even though the channel is gone. Without that, `subscribe` would create a
    // fresh *open* channel and wait forever for a run that finished long ago.
    expect(await collect(bus.subscribe("old"))).toEqual([]);
    expect(bus.trackedChannelCount).toBe(1);
  });

  it("frees a run that closed without producing anything", async () => {
    const bus = new MemoryRunEventBus();
    await bus.close("r");

    expect(bus.trackedChannelCount).toBe(0);
    expect(await collect(bus.subscribe("r"))).toEqual([]);
  });

  it("remembers a finished run for its TTL, then forgets it", async () => {
    // Matches `RedisRunEventBus`'s 24h closed marker. The two drivers implement one contract, so a
    // late join must not depend on which is configured.
    let now = 1_000_000;
    const bus = new MemoryRunEventBus({
      maxRetainedRuns: 1,
      finishedIdTtlMs: 60_000,
      now: () => now,
    });

    await bus.publish("old", frame(1));
    await bus.close("old");
    await bus.publish("filler", frame(1));
    await bus.close("filler"); // evicts "old"'s channel, remembering the id

    expect(await collect(bus.subscribe("old"))).toEqual([]); // completes, does not hang

    now += 60_001; // past the TTL
    await bus.publish("newer", frame(1));
    await bus.close("newer"); // any close sweeps expired ids

    // Forgotten now, so a join waits for frames that will never come — the same thing Redis does once
    // its closed marker expires. Asserted as "did not settle", which is the honest shape of the claim.
    const iterator = bus.subscribe("old")[Symbol.asyncIterator]();
    let settled = false;
    void iterator.next().then(() => {
      settled = true;
    });
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
    expect(settled).toBe(false);
    // Not awaited. An async generator suspended on an `await` cannot be force-returned — `return()`
    // is only honoured at a yield point — so awaiting here would hang the test. The SSE transports
    // fire-and-forget this call for the same reason.
    void iterator.return?.(undefined);
    await bus.close("old"); // let the parked generator finish so it does not outlive the test
  });

  it("frees the channel a doomed subscriber created once the run closes", async () => {
    // `subscribe` to an id the bus has not seen — a `join` to a run on another instance, or one past
    // its TTL — has to create a channel to wait on. Each one would otherwise strand a channel
    // permanently, which is growth on exactly the path this bounding work exists to close.
    const bus = new MemoryRunEventBus();
    const readers = Array.from({ length: 100 }, (_unused, index) =>
      collect(bus.subscribe(`unknown-${index}`)),
    );

    expect(bus.trackedChannelCount).toBe(100);
    for (let index = 0; index < 100; index += 1) await bus.close(`unknown-${index}`);
    await Promise.all(readers);

    expect(bus.trackedChannelCount).toBe(0);
  });

  it("rejects a nonsensical bound rather than silently misbehaving", () => {
    // `maxFramesPerRun: 0` would drop every frame; `maxRetainedRuns: 0` would retain nothing. The
    // class is public and constructed directly via `overrides`, so it validates its own options.
    expect(() => new MemoryRunEventBus({ maxFramesPerRun: 0 })).toThrow(RangeError);
    expect(() => new MemoryRunEventBus({ maxRetainedRuns: -1 })).toThrow(RangeError);
  });

  it("drops the oldest frames once a single run exceeds its cap", async () => {
    const bus = new MemoryRunEventBus({ maxFramesPerRun: 10 });

    for (let seq = 1; seq <= 1_000; seq += 1) await bus.publish("r", frame(seq));
    await bus.close("r");

    expect(bus.bufferedFrameCount).toBe(10);
    // Newest kept, oldest dropped — a late joiner gets the tail, which is what it wants.
    expect((await collect(bus.subscribe("r"))).map((f) => f.seq)).toEqual([
      991, 992, 993, 994, 995, 996, 997, 998, 999, 1000,
    ]);
  });

  it("does not buffer without bound for a background run nobody is watching", async () => {
    // The case that made this a production problem rather than a dev one: `publish` is
    // unconditional, so a background run streaming tokens into a bus with zero subscribers used to
    // retain every frame of its output.
    const bus = new MemoryRunEventBus({ maxFramesPerRun: 100 });

    for (let seq = 1; seq <= 50_000; seq += 1) await bus.publish("background", frame(seq));

    expect(bus.bufferedFrameCount).toBe(100);
  });

  it("ends a subscriber's stream when frames it had not read were dropped", async () => {
    // A silent skip would hand the client a hole in the sequence — in `values` mode, a corrupt view
    // of the graph's state. Ending the stream is recoverable: the client reconnects from its last id.
    const bus = new MemoryRunEventBus({ maxFramesPerRun: 3 });
    await bus.publish("r", frame(1));

    const seen: number[] = [];
    const reader = (async () => {
      for await (const received of bus.subscribe("r")) {
        seen.push(received.seq);
        // Outrun the reader while it is suspended in this yield.
        if (received.seq === 1) {
          for (let seq = 2; seq <= 20; seq += 1) await bus.publish("r", frame(seq));
          // Closing keeps the test hang-proof: a regression that fails to notice the gap terminates
          // on `closed` and fails the assertion below, rather than timing out and telling us nothing.
          await bus.close("r");
        }
      }
    })();

    await reader;

    // It read frame 1, then everything up to 17 was evicted behind it, so it stopped rather than
    // resuming at 18 as though nothing had been missed.
    expect(seen).toEqual([1]);
  });

  it("delivers every frame exactly once to a reader that keeps up across repeated trims", async () => {
    // The success direction of the cursor fix, and the shape the bug actually took: `#trim` read an
    // index the generator had not yet updated, so it discarded frames the reader had not seen —
    // silently, while every failure-direction assertion still passed. An over-aggressive decrement
    // would truncate this healthy reader.
    const bus = new MemoryRunEventBus({ maxFramesPerRun: 3 });
    const seen: number[] = [];
    const reader = (async () => {
      for await (const received of bus.subscribe("r")) seen.push(received.seq);
    })();

    for (let seq = 1; seq <= 20; seq += 1) {
      await bus.publish("r", frame(seq));
      await Promise.resolve(); // let the reader consume before the next publish trims
    }
    await bus.close("r");
    await reader;

    expect(seen).toEqual(Array.from({ length: 20 }, (_unused, index) => index + 1));
  });

  it("keeps two subscribers at different positions consistent across a trim", async () => {
    // `#trim` shifts every entry in `channel.readers`; nothing else exercises more than one.
    const bus = new MemoryRunEventBus({ maxFramesPerRun: 3 });
    await bus.publish("r", frame(1));
    await bus.publish("r", frame(2));

    const fast = bus.subscribe("r")[Symbol.asyncIterator]();
    const slow = bus.subscribe("r")[Symbol.asyncIterator]();
    // Deliberately at different positions: fast has consumed two frames, slow only one.
    expect((await fast.next()).value).toMatchObject({ seq: 1 });
    expect((await fast.next()).value).toMatchObject({ seq: 2 });
    expect((await slow.next()).value).toMatchObject({ seq: 1 });

    // Just past the cap of 3, so exactly one frame is trimmed — enough that the `readers` shift
    // actually runs, but not so much that the further-ahead reader falls off the front. An earlier
    // version published exactly `maxFramesPerRun` frames, so `#trim` returned early every time and
    // the whole shift could have been deleted with the test still passing.
    for (let seq = 3; seq <= 4; seq += 1) await bus.publish("r", frame(seq));
    expect(bus.bufferedFrameCount).toBe(3);

    // Each resumes where it left off, shifted by the same trim: no repeats, no skips.
    expect((await fast.next()).value).toMatchObject({ seq: 3 });
    expect((await slow.next()).value).toMatchObject({ seq: 2 });

    await bus.close("r");
    void fast.return?.(undefined);
    void slow.return?.(undefined);
  });

  it("rejects a fractional cap, which would corrupt the stream rather than merely misbehave", () => {
    // `splice(0, 1.5)` removes one frame while `cursor -= 1.5` shifts by one and a half, leaving the
    // cursor between elements: `frames[2.5]` is undefined and gets skipped silently, and the half-step
    // re-yields a frame the subscriber already saw.
    expect(() => new MemoryRunEventBus({ maxFramesPerRun: 2.5 })).toThrow(RangeError);
  });

  it("counts a double close once, so cancelled runs do not skew the retention window", async () => {
    // `close` is genuinely called twice for a cancelled run — once by the cancel path and again by
    // the engine's `finally`.
    const bus = new MemoryRunEventBus({ maxRetainedRuns: 2 });

    for (const runId of ["a", "b"]) {
      await bus.publish(runId, frame(1));
      await bus.close(runId);
      await bus.close(runId);
    }

    // Both are still within a window of 2; a duplicated entry would have pushed "a" out.
    expect((await collect(bus.subscribe("a"))).map((f) => f.seq)).toEqual([1]);
    expect((await collect(bus.subscribe("b"))).map((f) => f.seq)).toEqual([1]);
  });

  it("keeps replay working for a client that reconnects mid-run", async () => {
    // The reconnect path must survive all of the above: the run is still open, so nothing is
    // released while the client is away.
    const bus = new MemoryRunEventBus();
    await bus.publish("r", frame(1));
    await bus.publish("r", frame(2));

    const first = bus.subscribe("r")[Symbol.asyncIterator]();
    expect((await first.next()).value).toMatchObject({ seq: 1 });
    await first.return?.(undefined); // client drops

    await bus.publish("r", frame(3));
    await bus.close("r");

    expect((await collect(bus.subscribe("r", 1))).map((f) => f.seq)).toEqual([2, 3]);
  });
});
