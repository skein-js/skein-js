import { randomUUID } from "node:crypto";

import {
  runThreadEventBusConformance,
  startRedis,
  type StartedResource,
} from "@skein-js/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisThreadEventBus } from "./redis-thread-event-bus.js";

let redis: StartedResource;
beforeAll(async () => {
  redis = await startRedis();
});
afterAll(async () => {
  await redis?.stop();
});
runThreadEventBusConformance("redis", () => new RedisThreadEventBus(redis.url));

describe("thread events across instances", () => {
  it("reconnects on a different connection and preserves publication order", async () => {
    const producer = new RedisThreadEventBus(redis.url);
    const replica = new RedisThreadEventBus(redis.url);
    const id = randomUUID();
    const entry = {
      kind: "run" as const,
      runId: "one",
      frame: { seq: 1, event: "values" as const, data: {} },
    };
    try {
      await producer.publish(id, entry);
      const iterator = replica.subscribe(id, 1)[Symbol.asyncIterator]();
      const next = iterator.next();
      await producer.publish(id, { ...entry, runId: "two" });
      expect((await next).value).toMatchObject({ seq: 2, runId: "two" });
      await iterator.return?.();
    } finally {
      await Promise.all([producer.dispose(), replica.dispose()]);
    }
  });
});
