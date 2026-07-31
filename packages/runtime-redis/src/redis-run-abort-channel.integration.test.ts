// The Redis abort channel against a real server. Cross-process delivery is the whole point, so the
// assertions that matter need two independently-constructed channels — a stub can only prove the shape.

import { startRedis, type StartedResource } from "@skein-js/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisRunAbortChannel } from "./redis-run-abort-channel.js";

let redis: StartedResource;

beforeAll(async () => {
  redis = await startRedis();
});
afterAll(async () => {
  await redis?.stop();
});

/** Resolves once `predicate` holds, or throws — pub/sub delivery is asynchronous. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

describe("RedisRunAbortChannel", () => {
  it("delivers a request published by another instance", async () => {
    // Two channels over one Redis, as two replicas are.
    const publisher = new RedisRunAbortChannel(redis.url);
    const listener = new RedisRunAbortChannel(redis.url);
    const received: { run_id: string; reason: string }[] = [];
    const subscription = listener.subscribe((request) => received.push(request));
    try {
      // The subscribe is asynchronous, so publish until it lands rather than racing it once.
      await waitFor(() => {
        void publisher.requestAbort({ run_id: "run-1", reason: "cancel" });
        return received.length > 0;
      });

      expect(received[0]).toEqual({ run_id: "run-1", reason: "cancel" });
    } finally {
      await subscription.close();
      await publisher.dispose();
      await listener.dispose();
    }
  });

  it("delivers to every instance, since only the executor knows the run", async () => {
    // One channel per process and no routing: an abort goes to all of them and the ones not executing
    // the run ignore it. That is why there is no per-run subscription to manage.
    const publisher = new RedisRunAbortChannel(redis.url);
    const first = new RedisRunAbortChannel(redis.url);
    const second = new RedisRunAbortChannel(redis.url);
    const heard: string[] = [];
    const subscriptions = [
      first.subscribe(() => heard.push("first")),
      second.subscribe(() => heard.push("second")),
    ];
    try {
      await waitFor(() => {
        void publisher.requestAbort({ run_id: "run-2", reason: "interrupt" });
        return heard.includes("first") && heard.includes("second");
      });
      expect(new Set(heard)).toEqual(new Set(["first", "second"]));
    } finally {
      for (const subscription of subscriptions) await subscription.close();
      await publisher.dispose();
      await first.dispose();
      await second.dispose();
    }
  });

  it("ignores a malformed message instead of handing it to the engine", async () => {
    // A shared Redis can carry anything on this channel. An unvalidated `reason` would reach the run
    // engine and decide which terminal status a run settles to.
    const publisher = new RedisRunAbortChannel(redis.url);
    const errors: unknown[] = [];
    const listener = new RedisRunAbortChannel(redis.url, {
      onError: (error) => errors.push(error),
    });
    const delivered: unknown[] = [];
    const subscription = listener.subscribe((request) => delivered.push(request));
    try {
      // *Only* malformed messages are ever published to this listener, so `delivered` staying empty
      // cannot be a timing artifact of a valid one landing late. `reason` is not one skein recognizes.
      await waitFor(() => {
        void publisher.requestAbort({ run_id: "run-4", reason: "obliterate" as never });
        return errors.length > 0;
      });

      expect(delivered).toEqual([]);
      expect(String(errors[0])).toContain("malformed");
    } finally {
      await subscription.close();
      await publisher.dispose();
      await listener.dispose();
    }
  });

  it("stops delivering once the subscription is closed", async () => {
    const publisher = new RedisRunAbortChannel(redis.url);
    const listener = new RedisRunAbortChannel(redis.url);
    const received: unknown[] = [];
    const subscription = listener.subscribe((request) => received.push(request));
    try {
      await waitFor(() => {
        void publisher.requestAbort({ run_id: "run-5", reason: "cancel" });
        return received.length > 0;
      });

      await subscription.close();
      received.length = 0;
      await publisher.requestAbort({ run_id: "run-6", reason: "cancel" });
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(received).toEqual([]);
    } finally {
      await publisher.dispose();
      await listener.dispose();
    }
  });

  it("publishes nothing after dispose, and does not throw", async () => {
    // Teardown ordering is not something a caller should have to get right: a late cancel arriving
    // during shutdown must not reject.
    const channel = new RedisRunAbortChannel(redis.url);
    await channel.dispose();
    await expect(
      channel.requestAbort({ run_id: "run-7", reason: "cancel" }),
    ).resolves.toBeUndefined();
  });
});
