// The idempotency sweeper. Unlike the thread TTL sweeper it guards no invariant — a claim takes over
// an expired record itself — so what matters here is that it reclaims space and that no failure mode
// silently ends sweeping for the life of the process.

import { MemorySkeinStore } from "@skein-js/storage-memory";
import { describe, expect, it, vi } from "vitest";

import { createIdempotencySweeper } from "./idempotency-sweeper.js";

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const claim = (key: string, expiresInMs: number) => ({
  key,
  scope: "POST /runs alice",
  fingerprint: "fp",
  claim_id: `c-${key}`,
  now: new Date().toISOString(),
  expires_at: new Date(Date.now() + expiresInMs).toISOString(),
});

describe("idempotency sweeper", () => {
  it("removes expired records and leaves live ones", async () => {
    const store = new MemorySkeinStore();
    const sweeper = createIdempotencySweeper({ store, logger: silentLogger });
    await store.idempotency.claim(claim("gone", 40));
    await store.idempotency.claim(claim("kept", 60_000));

    await wait(120);

    expect(await sweeper.sweepOnce()).toBe(1);
    expect(await store.idempotency.get("POST /runs alice", "kept")).not.toBeNull();
  });

  it("is idempotent — a second sweep finds nothing", async () => {
    const store = new MemorySkeinStore();
    const sweeper = createIdempotencySweeper({ store, logger: silentLogger });
    await store.idempotency.claim(claim("gone", 40));

    await wait(120);
    await sweeper.sweepOnce();

    expect(await sweeper.sweepOnce()).toBe(0);
  });

  it("keeps sweeping after a driver failure", async () => {
    // The reschedule is in a `finally` and the catch never rethrows, so one bad tick must not end
    // sweeping for the life of the process.
    const store = new MemorySkeinStore();
    const sweepExpired = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue(3);
    const sweeper = createIdempotencySweeper({
      store: { idempotency: { ...store.idempotency, sweepExpired } },
      logger: silentLogger,
    });

    await expect(sweeper.sweepOnce()).rejects.toThrow("connection reset");
    expect(await sweeper.sweepOnce()).toBe(3);
  });

  it("stop() waits out a sweep already in flight", async () => {
    let settled = false;
    const store = new MemorySkeinStore();
    const sweeper = createIdempotencySweeper(
      {
        store: {
          idempotency: {
            ...store.idempotency,
            sweepExpired: async () => {
              await wait(30);
              settled = true;
              return 0;
            },
          },
        },
        logger: silentLogger,
      },
      { sweepIntervalMinutes: 1 / 60_000 },
    );

    sweeper.start();
    await wait(10);
    await sweeper.stop();

    // Resolving means nothing is still deleting into a store the host is about to tear down.
    expect(settled).toBe(true);
  });

  it("start() is idempotent, so a double start does not leave a stray timer", async () => {
    const store = new MemorySkeinStore();
    const sweeper = createIdempotencySweeper({ store, logger: silentLogger });

    sweeper.start();
    sweeper.start();

    await expect(sweeper.stop()).resolves.toBeUndefined();
  });
});
