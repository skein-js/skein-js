import type { QueuedRun, RunConsumer, RunQueue } from "@skein-js/core";
import { afterEach, describe, expect, it } from "vitest";

import type { RunQueueFactory } from "./queue-conformance.js";

/** Optional capability, required from every bundled queue. Existing consume conformance stays intact. */
export function runPartitionedRunQueueConformance(label: string, makeQueue: RunQueueFactory): void {
  describe(`Partitioned RunQueue conformance — ${label}`, () => {
    const queues: RunQueue[] = [];
    const consumers: RunConsumer[] = [];
    const make = async () => {
      const queue = await makeQueue();
      queues.push(queue);
      expect(queue.consumePartitioned).toBeTypeOf("function");
      return queue;
    };
    const consume = (
      queue: RunQueue,
      process: (run: QueuedRun) => Promise<boolean>,
      concurrency = 1,
    ) => {
      const consumer = queue.consumePartitioned!(process, { concurrency });
      consumers.push(consumer);
      return consumer;
    };
    afterEach(async () => {
      for (const consumer of consumers.splice(0)) await consumer.close(true);
      for (const queue of queues.splice(0)) {
        if ("dispose" in queue) await (queue as RunQueue & { dispose(): Promise<void> }).dispose();
      }
    });

    it("retains a busy head and deduplicates it while other threads progress", async () => {
      const queue = await make();
      for (const [run_id, thread_id] of [
        ["head", "hot"],
        ["tail", "hot"],
        ["cold", "cold"],
      ]) {
        await queue.enqueue({ run_id: run_id!, thread_id: thread_id! });
      }
      let available = false;
      let attempts = 0;
      const handled: string[] = [];
      consume(queue, async (run) => {
        if (run.run_id === "head") {
          attempts++;
          if (!available) return false;
        }
        handled.push(run.run_id);
        return true;
      });
      // Establish processor startup separately from dispatch progress. Redis opens worker
      // connections asynchronously; their handshake is not part of this busy-partition contract.
      await expect.poll(() => attempts, { timeout: 4000 }).toBeGreaterThanOrEqual(1);
      await expect.poll(() => handled.includes("cold")).toBe(true);
      await expect.poll(() => attempts).toBeGreaterThanOrEqual(3);
      expect(handled).toEqual(["cold"]);
      await queue.enqueue({ run_id: "head", thread_id: "hot" });
      available = true;
      await expect.poll(() => handled.length, { timeout: 4000 }).toBe(3);
      expect(handled).toEqual(["cold", "head", "tail"]);
    });

    it("serializes a partition while filling capacity with independent threads", async () => {
      const queue = await make();
      for (const [run_id, thread_id] of [
        ["head", "hot"],
        ["tail", "hot"],
        ["cold", "cold"],
      ]) {
        await queue.enqueue({ run_id: run_id!, thread_id: thread_id! });
      }
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started: string[] = [];
      let active = 0;
      let peak = 0;
      consume(
        queue,
        async (run) => {
          started.push(run.run_id);
          peak = Math.max(peak, ++active);
          try {
            if (run.run_id === "head") await held;
          } finally {
            active--;
          }
          return true;
        },
        2,
      );
      try {
        await expect.poll(() => started.includes("cold")).toBe(true);
        expect(started).not.toContain("tail");
        expect(peak).toBe(2);
      } finally {
        release();
      }
      await expect.poll(() => started.includes("tail"), { timeout: 4000 }).toBe(true);
    });

    it("keeps a delayed run's original floor and allows a later immediate run", async () => {
      const queue = await make();
      const notBefore = Date.now() + 200;
      await queue.enqueue({ run_id: "delayed", thread_id: "t" }, { delayMs: 200 });
      await queue.enqueue({ run_id: "immediate", thread_id: "t" });
      const handled: string[] = [];
      let startedAt = 0;
      consume(queue, async (run) => {
        handled.push(run.run_id);
        if (run.run_id === "delayed") startedAt = Date.now();
        return true;
      });
      await expect.poll(() => handled.length).toBe(2);
      expect([...handled].sort()).toEqual(["delayed", "immediate"]);
      expect(startedAt).toBeGreaterThanOrEqual(notBefore);
    });

    it("shares partition exclusion between independent consumers of the same queue", async () => {
      const queue = await make();
      await queue.enqueue({ run_id: "head", thread_id: "hot" });
      await queue.enqueue({ run_id: "tail", thread_id: "hot" });
      await queue.enqueue({ run_id: "cold", thread_id: "cold" });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started: string[] = [];
      const process = async (run: QueuedRun) => {
        started.push(run.run_id);
        if (run.run_id === "head") await held;
        return true;
      };
      consume(queue, process);
      try {
        await expect.poll(() => started).toEqual(["head"]);
        consume(queue, process);
        await expect.poll(() => started.includes("cold")).toBe(true);
        expect(started).not.toContain("tail");
      } finally {
        release();
      }
      await expect.poll(() => started, { timeout: 4000 }).toEqual(["head", "cold", "tail"]);
    });

    it("leaves a deferred run available after graceful close", async () => {
      const queue = await make();
      await queue.enqueue({ run_id: "deferred", thread_id: "t" });
      let attempted = false;
      const first = consume(queue, async () => {
        attempted = true;
        return false;
      });
      await expect.poll(() => attempted).toBe(true);
      await first.close();
      const handled: string[] = [];
      consume(queue, async (run) => {
        handled.push(run.run_id);
        return true;
      });
      await expect.poll(() => handled, { timeout: 4000 }).toEqual(["deferred"]);
    });

    it("does not let a failed partition head strand its successor", async () => {
      const queue = await make();
      await queue.enqueue({ run_id: "failed", thread_id: "t" });
      await queue.enqueue({ run_id: "successor", thread_id: "t" });
      let completed = false;
      consume(queue, async (run) => {
        if (run.run_id === "failed") throw new Error("Processor failed");
        completed = true;
        return true;
      });
      await expect.poll(() => completed, { timeout: 4000 }).toBe(true);
    });

    it("supports forced close while a processor is still running", async () => {
      const queue = await make();
      await queue.enqueue({ run_id: "running", thread_id: "t" });
      let release!: () => void;
      let started = false;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const consumer = consume(queue, async () => {
        started = true;
        await held;
        return true;
      });
      try {
        await expect.poll(() => started).toBe(true);
        await consumer.close(true);
      } finally {
        release();
      }
    });
  });
}
