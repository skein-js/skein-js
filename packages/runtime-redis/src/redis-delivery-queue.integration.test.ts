import { randomUUID } from "node:crypto";

import { startRedis, type StartedResource } from "@skein-js/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisDeliveryQueue } from "./redis-delivery-queue.js";

let redis: StartedResource;

beforeAll(async () => {
  redis = await startRedis();
});
afterAll(async () => {
  await redis?.stop();
});

describe("RedisDeliveryQueue immediate teardown", () => {
  it("disposes unused queues without interrupting connection startup", async () => {
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const queue = new RedisDeliveryQueue(redis.url, { queueName: `delivery-${randomUUID()}` });
      await expect(queue.dispose()).resolves.toBeUndefined();
    }
  });

  it("gracefully closes newly created consumers before disposing their queue", async () => {
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const queue = new RedisDeliveryQueue(redis.url, { queueName: `delivery-${randomUUID()}` });
      const consumer = queue.consume(async () => {});
      try {
        await expect(consumer.close()).resolves.toBeUndefined();
      } finally {
        await queue.dispose();
      }
    }
  });
});
