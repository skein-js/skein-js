// The loop that drains the outbox. Driven with `tickOnce()` and an injected clock throughout — no
// test here waits on a timer, so none of them can be flaky for a reason that has nothing to do with
// delivery.

import type { Delivery, DeliveryCreate, RunStatus } from "@skein-js/core";
import { MemorySkeinStore } from "@skein-js/storage-memory";
import { describe, expect, it, vi } from "vitest";

import type { Logger, WebhookDispatcher } from "../deps.js";

import type { DeliveryQueue, QueuedDelivery, ScheduleDeliveryOptions } from "@skein-js/core";

import { DELIVERY_LEASE_MS } from "./delivery-config.js";
import { createDeliveryWorker } from "./delivery-worker.js";

const START = new Date("2026-01-01T00:00:00.000Z");

function collectingLogger() {
  const errors: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string) => errors.push(message),
  };
  return { logger, errors };
}

/** A `DeliveryQueue` that records what it was asked to schedule instead of talking to Redis. */
function stubQueue() {
  const scheduled: { delivery: QueuedDelivery; options?: ScheduleDeliveryOptions }[] = [];
  const queue: DeliveryQueue = {
    schedule: async (delivery, options) => {
      scheduled.push({ delivery, ...(options ? { options } : {}) });
    },
    consume: () => ({ close: async () => {} }),
    durable: true,
  };
  return { queue, scheduled };
}

/** Due already, so a tick claims it. */
const inPast = (): string => new Date(START.getTime() - 1_000).toISOString();

/** A clock the test moves by hand. */
function movableClock(from = START) {
  let now = from.getTime();
  return {
    clock: (): Date => new Date(now),
    advance: (ms: number): void => {
      now += ms;
    },
  };
}

/** A store with one finished run that owes a callback, and the delivery it recorded. */
async function seedDelivery(
  store: MemorySkeinStore,
  overrides: Partial<DeliveryCreate> = {},
  status: RunStatus = "success",
): Promise<Delivery> {
  const thread = await store.threads.create();
  const run = await store.runs.create({ thread_id: thread.thread_id, assistant_id: "a" });
  const { delivery } = await store.runs.finalizeWithDelivery!(run.run_id, {
    status,
    delivery: {
      thread_id: thread.thread_id,
      url: "https://hooks.example.test/skein",
      payload: { run_id: run.run_id, values: {} },
      next_attempt_at: START.toISOString(),
      expires_at: new Date(START.getTime() + 3_600_000).toISOString(),
      ...overrides,
    },
  });
  return delivery;
}

describe("delivery worker", () => {
  it("claims a due delivery, sends it and marks it delivered", async () => {
    const store = new MemorySkeinStore();
    const delivery = await seedDelivery(store);
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const worker = createDeliveryWorker({
      store,
      webhookDispatcher: dispatch,
      logger: collectingLogger().logger,
      clock: () => START,
    });

    const summary = await worker.tickOnce();

    expect(summary).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await store.deliveries!.get(delivery.delivery_id))?.status).toBe("delivered");
  });

  it("leaves a delivery that is not due yet alone", async () => {
    const store = new MemorySkeinStore();
    await seedDelivery(store, {
      next_attempt_at: new Date(START.getTime() + 60_000).toISOString(),
    });
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const worker = createDeliveryWorker({
      store,
      webhookDispatcher: dispatch,
      logger: collectingLogger().logger,
      clock: () => START,
    });

    expect(await worker.tickOnce()).toMatchObject({ claimed: 0 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("retries a failed delivery on a later tick, once its backoff has elapsed", async () => {
    const store = new MemorySkeinStore();
    const { clock, advance } = movableClock();
    let attempts = 0;
    const dispatch = vi.fn<WebhookDispatcher>().mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("receiver is down");
    });
    await seedDelivery(store);
    const worker = createDeliveryWorker({
      store,
      webhookDispatcher: dispatch,
      logger: collectingLogger().logger,
      clock,
    });

    expect(await worker.tickOnce()).toMatchObject({ claimed: 1, delivered: 0, failed: 1 });
    // Not due again immediately — that is the backoff doing its job.
    expect(await worker.tickOnce()).toMatchObject({ claimed: 0 });

    advance(10_000);
    expect(await worker.tickOnce()).toMatchObject({ claimed: 1, delivered: 1 });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  // The recovery case the lease exists for: a process claimed a delivery, started the POST, and died.
  // Nothing re-enqueues it — the row simply becomes due again when its lease lapses.
  it("takes over a delivery whose worker died mid-POST", async () => {
    const store = new MemorySkeinStore();
    const { clock, advance } = movableClock();
    // Leased exactly as the engine leases it, then abandoned: the inline attempt claimed the row,
    // started the POST, and the process died before it could record an outcome.
    const delivery = await seedDelivery(store, {
      next_attempt_at: new Date(START.getTime() + DELIVERY_LEASE_MS).toISOString(),
    });
    expect((await store.deliveries!.get(delivery.delivery_id))?.status).toBe("delivering");

    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const worker = createDeliveryWorker({
      store,
      webhookDispatcher: dispatch,
      logger: collectingLogger().logger,
      clock,
    });

    // While the lease holds, a peer must not touch it — or a slow POST would be sent twice.
    advance(DELIVERY_LEASE_MS - 1_000);
    expect(await worker.tickOnce()).toMatchObject({ claimed: 0 });

    advance(2_000);
    expect(await worker.tickOnce()).toMatchObject({ claimed: 1, delivered: 1 });
  });

  // Every instance runs one of these against the same store.
  it("does not let two workers deliver the same row twice", async () => {
    const store = new MemorySkeinStore();
    await seedDelivery(store);
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const make = () =>
      createDeliveryWorker({
        store,
        webhookDispatcher: dispatch,
        logger: collectingLogger().logger,
        clock: () => START,
      });

    const [first, second] = await Promise.all([make().tickOnce(), make().tickOnce()]);

    expect(first.claimed + second.claimed).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps draining the batch when one receiver fails", async () => {
    const store = new MemorySkeinStore();
    await seedDelivery(store, { url: "https://bad.example.test/hook" });
    await seedDelivery(store, { url: "https://good.example.test/hook" });
    const dispatch = vi.fn<WebhookDispatcher>().mockImplementation(async (url: string) => {
      if (url.includes("bad")) throw new Error("down");
    });
    const worker = createDeliveryWorker({
      store,
      webhookDispatcher: dispatch,
      logger: collectingLogger().logger,
      clock: () => START,
    });

    expect(await worker.tickOnce()).toMatchObject({ claimed: 2, delivered: 1, failed: 1 });
  });

  it("bounds one tick to the batch size", async () => {
    const store = new MemorySkeinStore();
    for (const _ of [0, 1, 2]) await seedDelivery(store);
    const worker = createDeliveryWorker(
      {
        store,
        webhookDispatcher: vi.fn<WebhookDispatcher>().mockResolvedValue(undefined),
        logger: collectingLogger().logger,
        clock: () => START,
      },
      { batchSize: 2 },
    );

    expect(await worker.tickOnce()).toMatchObject({ claimed: 2 });
    expect(await worker.tickOnce()).toMatchObject({ claimed: 1 });
  });

  // Regression: the retention block used to sit after an early `return` on the queue path, so
  // `retain_hours` was a no-op in exactly the deployments with the most rows — settled deliveries,
  // dead ones still holding their whole payload, accumulating forever.
  it("still reclaims settled deliveries when a queue owns the schedule", async () => {
    const store = new MemorySkeinStore();
    // Already past its retention when the sweep looks — `expires_at` is absolute, set at creation
    // from `retain_hours`, so the sweep compares it against plain `now`. Subtracting the retention
    // again here would keep every settled row for double what `retain_hours` says.
    const settled = await seedDelivery(store, { next_attempt_at: inPast(), expires_at: inPast() });
    await store.deliveries!.recordAttempt(settled.delivery_id, { outcome: "delivered" });
    const worker = createDeliveryWorker({
      store,
      webhookDispatcher: vi.fn<WebhookDispatcher>().mockResolvedValue(undefined),
      logger: collectingLogger().logger,
      clock: () => START,
      deliveryQueue: stubQueue().queue,
    });

    expect(await worker.tickOnce()).toMatchObject({ swept: 1 });
    expect(await store.deliveries!.get(settled.delivery_id)).toBeNull();
  });

  it("measures the retention cadence in elapsed time, not in ticks", async () => {
    // With a queue this loop ticks every five minutes rather than every five seconds, so a tick
    // *count* would stretch "every ten minutes" into every ten hours.
    const store = new MemorySkeinStore();
    const { clock, advance } = movableClock();
    const worker = createDeliveryWorker({
      store,
      webhookDispatcher: vi.fn<WebhookDispatcher>().mockResolvedValue(undefined),
      logger: collectingLogger().logger,
      clock,
      deliveryQueue: stubQueue().queue,
    });
    const sweepExpired = vi.spyOn(store.deliveries!, "sweepExpired");

    await worker.tickOnce();
    expect(sweepExpired).toHaveBeenCalledTimes(1);
    await worker.tickOnce();
    expect(sweepExpired).toHaveBeenCalledTimes(1);
    advance(700_000);
    await worker.tickOnce();
    expect(sweepExpired).toHaveBeenCalledTimes(2);
  });

  // Regression: the sweep used to re-schedule with no attempt budget, so BullMQ gave the job its
  // default of one — a recovered delivery would die on its next failure instead of finishing the
  // schedule its configuration promised, and it would look like the policy was ignored.
  it("re-schedules a lost job with the attempts it has left, not with one", async () => {
    const store = new MemorySkeinStore();
    const { queue, scheduled } = stubQueue();
    await seedDelivery(store, { next_attempt_at: inPast() });
    const worker = createDeliveryWorker({
      store,
      webhookDispatcher: vi.fn<WebhookDispatcher>().mockResolvedValue(undefined),
      logger: collectingLogger().logger,
      clock: () => START,
      deliveryQueue: queue,
      webhooks: { retries: { maxAttempts: 12 } },
    });

    expect(await worker.tickOnce()).toMatchObject({ claimed: 1 });
    // Eleven of twelve remain: only the inline attempt has been spent. The sweep reads rather than
    // claims, so merely looking at a delivery no longer costs it an attempt.
    expect(scheduled[0]?.options?.attempts).toBe(11);
  });

  // The property that lets the sweep run against a short horizon: looking is free. A claiming sweep
  // would spend the budget of every delivery the queue was merely holding, so `next_attempt_at` had
  // to be pushed hours out to keep the two apart — which is what made a lost job take hours to find.
  it("does not spend a delivery's attempts by sweeping for it", async () => {
    const store = new MemorySkeinStore();
    const { queue, scheduled } = stubQueue();
    const seeded = await seedDelivery(store, { next_attempt_at: inPast() });
    const worker = createDeliveryWorker({
      store,
      webhookDispatcher: vi.fn<WebhookDispatcher>().mockResolvedValue(undefined),
      logger: collectingLogger().logger,
      clock: () => START,
      deliveryQueue: queue,
    });

    await worker.tickOnce();
    await worker.tickOnce();
    await worker.tickOnce();

    const after = await store.deliveries!.get(seeded.delivery_id);
    expect(after?.attempt).toBe(seeded.attempt);
    expect(after?.next_attempt_at).toBe(seeded.next_attempt_at);
    // Re-scheduled each pass, which is safe because `schedule` is idempotent on the delivery id.
    expect(scheduled).toHaveLength(3);
  });

  it("hands a lost job back to the queue rather than POSTing it itself", async () => {
    const store = new MemorySkeinStore();
    const { queue, scheduled } = stubQueue();
    const delivery = await seedDelivery(store, { next_attempt_at: inPast() });
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const worker = createDeliveryWorker({
      store,
      webhookDispatcher: dispatch,
      logger: collectingLogger().logger,
      clock: () => START,
      deliveryQueue: queue,
    });

    await worker.tickOnce();

    expect(dispatch).not.toHaveBeenCalled();
    expect(scheduled.map((s) => s.delivery.delivery_id)).toEqual([delivery.delivery_id]);
  });

  it("is a no-op on a store with no deliveries repo", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const worker = createDeliveryWorker({
      store: {},
      webhookDispatcher: dispatch,
      logger: collectingLogger().logger,
      clock: () => START,
    });

    expect(await worker.tickOnce()).toEqual({ claimed: 0, delivered: 0, failed: 0, swept: 0 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  // The property that matters more than any single tick: no failure mode may silently end delivery
  // for the life of the process.
  it("keeps ticking after a tick throws", async () => {
    const store = new MemorySkeinStore();
    await seedDelivery(store);
    const { logger, errors } = collectingLogger();
    let calls = 0;
    const claimDue = store.deliveries!.claimDue.bind(store.deliveries);
    vi.spyOn(store.deliveries!, "claimDue").mockImplementation(async (query) => {
      calls += 1;
      if (calls === 1) throw new Error("database blip");
      return claimDue(query);
    });
    const worker = createDeliveryWorker(
      {
        store,
        webhookDispatcher: vi.fn<WebhookDispatcher>().mockResolvedValue(undefined),
        logger,
        clock: () => START,
      },
      { pollIntervalMs: 1 },
    );

    worker.start();
    await vi.waitFor(() => expect(calls).toBeGreaterThan(1), { timeout: 2_000 });
    await worker.stop();

    expect(errors.join("\n")).toContain("delivery tick failed");
  });

  it("waits out an in-flight POST when stopping, so shutdown cannot cut one off", async () => {
    const store = new MemorySkeinStore();
    await seedDelivery(store);
    let release: (() => void) | undefined;
    let finished = false;
    const dispatch = vi.fn<WebhookDispatcher>().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            finished = true;
            resolve();
          };
        }),
    );
    const worker = createDeliveryWorker(
      {
        store,
        webhookDispatcher: dispatch,
        logger: collectingLogger().logger,
        clock: () => START,
      },
      { pollIntervalMs: 1 },
    );

    worker.start();
    await vi.waitFor(() => expect(release).toBeDefined(), { timeout: 2_000 });
    const stopping = worker.stop();
    release!();
    await stopping;

    expect(finished).toBe(true);
  });
});
