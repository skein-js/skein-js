import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { runPartitionedRunQueueConformance } from "@skein-js/test-support";
import { runRunQueueConformance, startRedis, type StartedResource } from "@skein-js/test-support";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisRunQueue } from "./redis-run-queue.js";

let redis: StartedResource;

beforeAll(async () => {
  redis = await startRedis();
});
afterAll(async () => {
  await redis?.stop();
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}

// A unique queue name per case isolates it without flushing the shared container.
runRunQueueConformance(
  "redis",
  () => new RedisRunQueue(redis.url, { queueName: `skein-test-${randomUUID()}` }),
);

describe("RedisRunQueue (BullMQ)", () => {
  it("preserves job identity and failure attempts across repeated busy deferrals", async () => {
    const queueName = `skein-test-${randomUUID()}`;
    const queue = new RedisRunQueue(redis.url, { queueName, attempts: 2 });
    const inspector = new Queue(queueName, { connection: { url: redis.url } });
    const client = new Redis(redis.url);
    let available = false;
    let probes = 0;
    let failures = 0;
    let handled = false;
    await queue.enqueue({ run_id: "identity", thread_id: "t" });
    const consumer = queue.consumePartitioned(async () => {
      probes++;
      if (!available) return false;
      if (failures++ === 0) throw new Error("Retry once");
      handled = true;
      return true;
    });
    try {
      await waitFor(() => probes >= 4);
      const job = await inspector.getJob("run-identity");
      expect(job?.id).toBe("run-identity");
      expect(job?.attemptsMade).toBe(0);
      available = true;
      await waitFor(() => handled);
      expect(failures).toBe(2);
      await expect.poll(async () => client.keys(`skein-dispatch:${queueName}:*`)).toEqual([]);
    } finally {
      await consumer.close();
      await queue.dispose();
      await inspector.close();
      await client.quit();
    }
  });

  it("retains deferred head order when all resource owners reopen", async () => {
    const queueName = `skein-test-${randomUUID()}`;
    const first = new RedisRunQueue(redis.url, { queueName });
    await first.enqueue({ run_id: "head", thread_id: "t" });
    await first.enqueue({ run_id: "tail", thread_id: "t" });
    let probes = 0;
    const consumer = first.consumePartitioned(async () => {
      probes++;
      return false;
    });
    await waitFor(() => probes >= 3);
    await consumer.close();
    await first.dispose();
    const reopened = new RedisRunQueue(redis.url, { queueName });
    const handled: string[] = [];
    const next = reopened.consumePartitioned(async (run) => {
      handled.push(run.run_id);
      return true;
    });
    try {
      await waitFor(() => handled.length === 2);
      expect(handled).toEqual(["head", "tail"]);
    } finally {
      await next.close();
      await reopened.dispose();
    }
  });

  it("recovers a killed worker's head before promoting its parked successor", async () => {
    const queueName = `skein-test-${randomUUID()}`;
    const producer = new RedisRunQueue(redis.url, { queueName });
    await producer.enqueue({ run_id: "head", thread_id: "t" });
    await producer.enqueue({ run_id: "tail", thread_id: "t" });
    // Exercise BullMQ's public manual-worker checker before starting the owner. This continuously
    // observes active jobs while preserving the real 30-second lock. Otherwise a shared checker
    // interval can require several production-length windows merely to discover the killed job.
    const checker = new Worker(queueName, undefined, {
      connection: { url: redis.url },
      autorun: false,
      stalledInterval: 1000,
    });
    await checker.startStalledCheckTimer();
    const child = fork(
      fileURLToPath(new URL("./__fixtures__/partition-crash.mjs", import.meta.url)),
      {
        env: { ...process.env, REDIS_URI: redis.url, QUEUE_NAME: queueName },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );
    const handled: string[] = [];
    let survivor: ReturnType<RedisRunQueue["consumePartitioned"]> | undefined;
    try {
      expect((await once(child, "message", { signal: AbortSignal.timeout(10_000) }))[0]).toBe(
        "head",
      );
      child.kill("SIGKILL");
      await once(child, "exit");
      survivor = producer.consumePartitioned(async (run) => {
        handled.push(run.run_id);
        return true;
      });
      await waitFor(() => handled.length === 2, 50_000);
      expect(handled).toEqual(["head", "tail"]);
    } finally {
      child.kill("SIGKILL");
      await survivor?.close();
      await checker.close();
      await producer.dispose();
    }
  }, 60_000);

  it("lets a worker on one instance execute a run enqueued by another", async () => {
    const queueName = `skein-test-${randomUUID()}`;
    const producer = new RedisRunQueue(redis.url, { queueName });
    const consumerInstance = new RedisRunQueue(redis.url, { queueName });
    const received: string[] = [];
    const consumer = consumerInstance.consume(async (run) => {
      received.push(run.run_id);
    });
    try {
      await producer.enqueue({ run_id: "cross", thread_id: "t" });
      await waitFor(() => received.length === 1);
      expect(received).toEqual(["cross"]);
    } finally {
      await consumer.close();
      await producer.dispose();
      await consumerInstance.dispose();
    }
  });
});

runPartitionedRunQueueConformance(
  "redis",
  () => new RedisRunQueue(redis.url, { queueName: `skein-partition-${randomUUID()}` }),
);
