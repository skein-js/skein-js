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

  it("trims a run's stream to approximately MAXLEN", async () => {
    const prefix = `skein:test:${randomUUID()}`;
    const bus = new RedisRunEventBus(redis.url, { keyPrefix: prefix, streamMaxLen: 100 });
    const raw = new Redis(redis.url);
    try {
      for (let seq = 1; seq <= 5000; seq += 1) await bus.publish("big", frame(seq));

      // A bracket, not an equality: `~` trims on whole-node boundaries, so the exact length is a
      // Redis implementation detail. What matters is that it is bounded rather than 5000.
      const length = await raw.xlen(`${prefix}:runs:stream:big`);
      expect(length).toBeGreaterThanOrEqual(100);
      expect(length).toBeLessThan(5000);
    } finally {
      await bus.dispose();
      raw.disconnect();
    }
  });

  it("replays a stream longer than one page, in order and without duplicates", async () => {
    // Paged replay is the part a fake cannot check: the exclusive-cursor arithmetic between pages is
    // where an off-by-one would silently repeat or skip a frame.
    const prefix = `skein:test:${randomUUID()}`;
    const bus = new RedisRunEventBus(redis.url, { keyPrefix: prefix, closedCheckIntervalMs: 50 });
    try {
      for (let seq = 1; seq <= 1200; seq += 1) await bus.publish("long", frame(seq));
      await bus.close("long");

      const seqs = (await collect(bus.subscribe("long"))).map((f) => f.seq);
      expect(seqs).toEqual(Array.from({ length: 1200 }, (_unused, index) => index + 1));
    } finally {
      await bus.dispose();
    }
  });

  it("keeps every subscriber fed from one shared pub/sub connection", async () => {
    const prefix = `skein:test:${randomUUID()}`;
    const bus = new RedisRunEventBus(redis.url, { keyPrefix: prefix, closedCheckIntervalMs: 50 });
    try {
      const received = Promise.all([
        collect(bus.subscribe("shared")),
        collect(bus.subscribe("shared")),
        collect(bus.subscribe("shared")),
      ]);
      // Let all three attach before publishing, so this exercises live fan-out rather than replay.
      await new Promise((resolve) => setTimeout(resolve, 100));

      await bus.publish("shared", frame(1));
      await bus.publish("shared", frame(2));
      await bus.close("shared");

      for (const frames of await received) {
        expect(frames.map((f) => f.seq)).toEqual([1, 2]);
      }
    } finally {
      await bus.dispose();
    }
  });

  it("resubscribes after the shared connection drops", async () => {
    // The shared connection is a shared failure domain, so ioredis's auto-resubscribe is now
    // load-bearing for every in-flight stream rather than for one.
    const prefix = `skein:test:${randomUUID()}`;
    // Captured through the injected factory rather than reached for on the instance: `#pubsub` is a
    // real private field, so `bus["#pubsub"]` reads a string-named property that does not exist and
    // quietly yields `undefined` — the disconnect below would be a no-op and this would pass without
    // testing anything.
    const opened: Redis[] = [];
    const bus = new RedisRunEventBus(redis.url, {
      keyPrefix: prefix,
      closedCheckIntervalMs: 50,
      createClient: (url, options) => {
        const client = new Redis(url, options ?? {});
        opened.push(client);
        return client;
      },
    });
    try {
      const received = collect(bus.subscribe("flaky"));
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The pub/sub connection is the one opened after the (lazy) command connection.
      expect(opened.length).toBeGreaterThanOrEqual(2);
      opened[opened.length - 1]?.disconnect(true); // drop it the way a Redis blip would
      await new Promise((resolve) => setTimeout(resolve, 300));

      await bus.publish("flaky", frame(1));
      await bus.close("flaky");

      // Frames published during the outage are recovered from the durable stream by the close sweep,
      // so the subscriber completes with them either way.
      expect((await received).map((f) => f.seq)).toEqual([1]);
    } finally {
      await bus.dispose();
    }
  });
});
