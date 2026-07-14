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
 * With the default concurrency of 1, a single consumer delivers runs in enqueue order.
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
      for (const instance of created.splice(0)) if (isDisposable(instance)) await instance.dispose();
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
      for (const instance of created.splice(0)) if (isDisposable(instance)) await instance.dispose();
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
