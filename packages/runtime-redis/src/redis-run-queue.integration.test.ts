import { randomUUID } from "node:crypto";

import { runRunQueueConformance, startRedis, type StartedResource } from "@skein-js/test-support";
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
