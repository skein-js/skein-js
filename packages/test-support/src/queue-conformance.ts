import type { RunEventBus, RunFrame, RunQueue } from "@skein-js/core";
import { afterEach, describe, expect, it } from "vitest";

/** Produces a fresh {@link RunQueue}. Called once per test so cases never share state. */
export type RunQueueFactory = () => RunQueue | Promise<RunQueue>;

/** Produces a fresh {@link RunEventBus}. Called once per test so cases never share state. */
export type RunEventBusFactory = () => RunEventBus | Promise<RunEventBus>;

/** A driver that owns connections exposes `dispose()`; the suite tears it down after each test. */
interface Disposable {
  dispose(): Promise<void>;
}

function isDisposable(value: unknown): value is Disposable {
  return typeof (value as { dispose?: unknown } | null)?.dispose === "function";
}

const frame = (seq: number): RunFrame => ({ seq, event: "values", data: { seq } });

async function collect(iterable: AsyncIterable<RunFrame>): Promise<RunFrame[]> {
  const out: RunFrame[] = [];
  for await (const f of iterable) out.push(f);
  return out;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

/**
 * The behavioral contract every {@link RunQueue} driver must satisfy — the in-memory queue and
 * `@skein-js/redis` run the *same* suite, so the run worker behaves identically whichever it has.
 * At the *driver's* default concurrency of 1 (what `consume()` uses when passed no options), a
 * single consumer delivers runs in enqueue order. The run worker passes a higher value by default,
 * above which no ordering across runs is guaranteed — see `DEFAULT_RUN_CONCURRENCY`.
 *
 * @example
 * runRunQueueConformance("memory", () => new MemoryRunQueue());
 */
export function runRunQueueConformance(label: string, makeQueue: RunQueueFactory): void {
  describe(`RunQueue conformance — ${label}`, () => {
    const created: unknown[] = [];
    const make = async (): Promise<RunQueue> => {
      const queue = await makeQueue();
      created.push(queue);
      return queue;
    };
    afterEach(async () => {
      for (const instance of created.splice(0))
        if (isDisposable(instance)) await instance.dispose();
    });

    it("delivers enqueued runs to a consumer in FIFO order", async () => {
      const queue = await make();
      const received: string[] = [];
      const consumer = queue.consume(async (run) => {
        received.push(run.run_id);
      });
      await queue.enqueue({ run_id: "1", thread_id: "t" });
      await queue.enqueue({ run_id: "2", thread_id: "t" });

      await waitFor(() => received.length === 2);
      await consumer.close();
      expect(received).toEqual(["1", "2"]);
    });

    // What makes the cron scheduler's outbox sweep safe: it re-enqueues runs it cannot prove
    // reached the queue, so enqueueing the same run twice must not execute it twice. Both drivers
    // key on the run id to dedupe — BullMQ via `jobId`, the memory queue by scanning its FIFO.
    it("does not deliver the same run twice when it is enqueued twice", async () => {
      const queue = await make();
      // Both enqueues happen **before** a consumer exists. With one running, a driver that drops a
      // finished job (BullMQ's `removeOnComplete`) can complete the first `dupe` before the second
      // `enqueue` round-trips, freeing the id and letting the duplicate through — a race that would
      // make this fail intermittently rather than assert the property.
      await queue.enqueue({ run_id: "dupe", thread_id: "t" });
      await queue.enqueue({ run_id: "dupe", thread_id: "t" });
      await queue.enqueue({ run_id: "other", thread_id: "t" });

      const received: string[] = [];
      const consumer = queue.consume(async (run) => {
        received.push(run.run_id);
      });

      // Waiting on the *second* id proves the first was not merely slow: it is behind `dupe` in the
      // queue, so by the time it lands any duplicate delivery would already have happened.
      await waitFor(() => received.includes("other"));
      await consumer.close();
      expect(received).toEqual(["dupe", "other"]);
    });

    it("delivers a run enqueued before the consumer starts", async () => {
      const queue = await make();
      await queue.enqueue({ run_id: "early", thread_id: "t" });

      const received: string[] = [];
      const consumer = queue.consume(async (run) => {
        received.push(run.run_id);
      });
      await waitFor(() => received.length === 1);
      await consumer.close();
      expect(received).toEqual(["early"]);
    });

    // `after_seconds`. Real timings rather than fake timers, because half of this suite runs against
    // BullMQ in a container, whose delayed set is driven by Redis' clock and not by ours.
    it("holds a delayed run back until its delay elapses", async () => {
      const queue = await make();
      const received: string[] = [];
      const consumer = queue.consume(async (run) => {
        received.push(run.run_id);
      });

      await queue.enqueue({ run_id: "later", thread_id: "t" }, { delayMs: 400 });
      // An undelayed run enqueued *after* it still goes first — the delay is a visibility time, not a
      // position in the queue.
      await queue.enqueue({ run_id: "now", thread_id: "t" });

      await waitFor(() => received.includes("now"));
      expect(received).not.toContain("later");

      await waitFor(() => received.includes("later"), 4000);
      await consumer.close();
      expect(received).toEqual(["now", "later"]);
    });

    it("treats a zero delay as an ordinary enqueue", async () => {
      const queue = await make();
      const received: string[] = [];
      const consumer = queue.consume(async (run) => {
        received.push(run.run_id);
      });

      await queue.enqueue({ run_id: "immediate", thread_id: "t" }, { delayMs: 0 });

      await waitFor(() => received.length === 1);
      await consumer.close();
      expect(received).toEqual(["immediate"]);
    });

    // The cron sweep re-enqueues runs it cannot prove reached the queue. A delayed run is exactly the
    // case that looks lost — `pending`, with nothing running — so a blind re-enqueue must not cut its
    // delay short or schedule it a second time.
    it("does not let a re-enqueue cut a pending delay short", async () => {
      const queue = await make();
      await queue.enqueue({ run_id: "delayed", thread_id: "t" }, { delayMs: 400 });
      await queue.enqueue({ run_id: "delayed", thread_id: "t" });

      const received: string[] = [];
      const consumer = queue.consume(async (run) => {
        received.push(run.run_id);
      });

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(received).toEqual([]);

      await waitFor(() => received.length === 1, 4000);
      // Long enough after it came due that a second delivery would have landed.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await consumer.close();
      expect(received).toEqual(["delayed"]);
    });
  });
}

/**
 * The behavioral contract every {@link RunEventBus} driver must satisfy: buffered replay for late
 * joiners, `afterSeq` reconnection, live-tail of frames published after subscribing, and iterator
 * completion on `close`. The in-memory bus and `@skein-js/redis` run the *same* suite.
 *
 * @example
 * runRunEventBusConformance("memory", () => new MemoryRunEventBus());
 */
export function runRunEventBusConformance(label: string, makeBus: RunEventBusFactory): void {
  describe(`RunEventBus conformance — ${label}`, () => {
    const created: unknown[] = [];
    const make = async (): Promise<RunEventBus> => {
      const bus = await makeBus();
      created.push(bus);
      return bus;
    };
    afterEach(async () => {
      for (const instance of created.splice(0))
        if (isDisposable(instance)) await instance.dispose();
    });

    it("replays buffered frames to a late subscriber, then completes on close", async () => {
      const bus = await make();
      await bus.publish("r", frame(1));
      await bus.publish("r", frame(2));
      await bus.close("r");

      expect((await collect(bus.subscribe("r"))).map((f) => f.seq)).toEqual([1, 2]);
    });

    it("honors afterSeq so a reconnecting client skips what it already saw", async () => {
      const bus = await make();
      for (const seq of [1, 2, 3]) await bus.publish("r", frame(seq));
      await bus.close("r");

      expect((await collect(bus.subscribe("r", 2))).map((f) => f.seq)).toEqual([3]);
    });

    it("live-tails frames published after the subscription starts", async () => {
      const bus = await make();
      const collected = collect(bus.subscribe("r"));
      // Let the subscription establish before publishing (redis pub/sub needs the SUBSCRIBE to land).
      await new Promise((resolve) => setTimeout(resolve, 50));

      await bus.publish("r", frame(1));
      await bus.publish("r", frame(2));
      await bus.close("r");

      expect((await collected).map((f) => f.seq)).toEqual([1, 2]);
    });
  });
}
