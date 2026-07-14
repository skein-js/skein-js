import { randomUUID } from "node:crypto";

import type { RunFrame } from "@skein-js/core";
import {
  runRunEventBusConformance,
  startRedis,
  type StartedResource,
} from "@skein-js/test-support";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisRunEventBus } from "./redis-run-event-bus.js";

let redis: StartedResource;

beforeAll(async () => {
  redis = await startRedis();
});
afterAll(async () => {
  await redis?.stop();
});

const frame = (seq: number): RunFrame => ({ seq, event: "values", data: { seq } });

async function collect(iterable: AsyncIterable<RunFrame>): Promise<RunFrame[]> {
  const out: RunFrame[] = [];
  for await (const f of iterable) out.push(f);
  return out;
}

// A unique key prefix per case isolates it without flushing the shared container.
runRunEventBusConformance(
  "redis",
  () => new RedisRunEventBus(redis.url, { keyPrefix: `skein:test:${randomUUID()}` }),
);

describe("RedisRunEventBus cross-instance", () => {
  it("fans a run's frames from the publishing instance to a subscriber on another", async () => {
    // Same key prefix = same run channels/streams, but two separate bus instances (as if two servers).
    const prefix = `skein:test:${randomUUID()}`;
    const publisher = new RedisRunEventBus(redis.url, { keyPrefix: prefix });
    const joiner = new RedisRunEventBus(redis.url, { keyPrefix: prefix });
    try {
      const received = collect(joiner.subscribe("run-x"));
      await new Promise((resolve) => setTimeout(resolve, 50)); // let the joiner's SUBSCRIBE land

      await publisher.publish("run-x", frame(1));
      await publisher.publish("run-x", frame(2));
      await publisher.close("run-x");

      expect((await received).map((f) => f.seq)).toEqual([1, 2]);
    } finally {
      await publisher.dispose();
      await joiner.dispose();
    }
  });

  it("completes (does not hang) when joining a closed run whose frame stream has expired", async () => {
    const prefix = `skein:test:${randomUUID()}`;
    const bus = new RedisRunEventBus(redis.url, { keyPrefix: prefix, closedCheckIntervalMs: 50 });
    const raw = new Redis(redis.url);
    try {
      await bus.publish("gone", frame(1));
      await bus.close("gone");
      // Simulate the frame stream's TTL lapsing while the durable closed marker survives.
      await raw.del(`${prefix}:runs:stream:gone`);

      // Without the closed marker + periodic check, this would live-tail forever.
      const drained = await Promise.race([
        collect(bus.subscribe("gone")).then((frames) => frames.length),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 3000)),
      ]);
      expect(drained).toBe(0); // stream gone, so no frames replay, but it completes
    } finally {
      await bus.dispose();
      raw.disconnect();
    }
  });
});
