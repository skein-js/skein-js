// `settleBullConnection` across BullMQ majors.
//
// This helper runs on the shutdown path, where it is the *last* thing that should ever throw. It read
// `resource.client.then(...)` unconditionally, which is BullMQ 5's spelling; BullMQ 6 removed that
// getter, so reading it yields `undefined` and every stop ended with
// `Cannot read properties of undefined (reading 'then')` reported as an unclean shutdown.
//
// The manifest range said `>=5.0.0`, so a fresh `npm install` resolved BullMQ 6 and got exactly that.

import { describe, expect, it } from "vitest";

import { CONNECTION_SETTLE_TIMEOUT_MS, settleBullConnection } from "./redis-connection.js";

describe("settleBullConnection", () => {
  it("settles a BullMQ 5 resource through `client`", async () => {
    let awaited = false;
    await settleBullConnection({
      client: Promise.resolve().then(() => {
        awaited = true;
      }),
    });
    expect(awaited).toBe(true);
  });

  it("settles a BullMQ 6 resource through `waitUntilReady()`", async () => {
    let calls = 0;
    await settleBullConnection({
      waitUntilReady: async () => {
        calls += 1;
      },
    });
    expect(calls).toBe(1);
  });

  it("is a no-op when the resource offers neither", async () => {
    // The shape that used to throw. Settling is an optimisation over closing; the close that follows
    // is what actually has to happen, so an unrecognised resource must not fail the shutdown.
    await expect(settleBullConnection({})).resolves.toBeUndefined();
    await expect(settleBullConnection({ client: undefined })).resolves.toBeUndefined();
  });

  it("swallows a rejected connection rather than failing teardown", async () => {
    await expect(
      settleBullConnection({ client: Promise.reject(new Error("ECONNREFUSED")) }),
    ).resolves.toBeUndefined();
    await expect(
      settleBullConnection({
        waitUntilReady: () => Promise.reject(new Error("ECONNREFUSED")),
      }),
    ).resolves.toBeUndefined();
  });

  it("survives a resource that throws synchronously", async () => {
    // A partly-constructed Queue or Worker throws straight out of the getter or the call. Letting
    // that escape would skip the `close()` the caller runs next — the same shape as the bug this
    // helper is being fixed for, just one level up.
    await expect(
      settleBullConnection({
        waitUntilReady: () => {
          throw new Error("backend is not ready");
        },
      }),
    ).resolves.toBeUndefined();

    await expect(
      settleBullConnection(
        Object.create(null, {
          client: {
            get() {
              throw new Error("connection is undefined");
            },
          },
        }) as { client?: Promise<unknown> },
      ),
    ).resolves.toBeUndefined();
  });

  it("prefers `waitUntilReady()` when a resource somehow has both", async () => {
    // Defensive ordering: the newer spelling is the one that works on the newer major, and a v6
    // resource carrying a vestigial `client` must not be settled through the dead one.
    //
    // Discriminated by a `client` that never settles: picking it would leave this to the 1s timeout,
    // so finishing promptly is the assertion. Comparing "which callback ran" would not work — the
    // `client` promise's own `.then` runs either way, whatever this function awaited.
    let called = 0;
    const started = Date.now();
    await settleBullConnection({
      client: new Promise(() => {}),
      waitUntilReady: async () => {
        called += 1;
      },
    });
    expect(called).toBe(1);
    expect(Date.now() - started).toBeLessThan(CONNECTION_SETTLE_TIMEOUT_MS);
  });
});
