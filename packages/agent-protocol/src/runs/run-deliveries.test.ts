// The operator's view of a run's callbacks: what was owed, what was tried, and the replay.

import type { Delivery } from "@skein-js/core";
import { describe, expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { createProtocolHandlers } from "../create-handlers.js";
import { createProtocolServiceFromContext } from "../service.js";
import type { ProtocolService } from "../service.js";

/** A finished run that owes a callback, plus the delivery recorded alongside it. */
async function seedDelivery(
  service: ProtocolService,
  deps: ReturnType<typeof createFixtureDeps>,
  overrides: { url?: string } = {},
): Promise<{ runId: string; threadId: string; delivery: Delivery }> {
  const thread = await service.threads.create();
  const run = await deps.store.runs.create({ thread_id: thread.thread_id, assistant_id: "echo" });
  const { delivery } = await deps.store.runs.finalizeWithDelivery!(run.run_id, {
    status: "success",
    delivery: {
      thread_id: thread.thread_id,
      url: overrides.url ?? "https://hooks.example.test/skein",
      payload: { run_id: run.run_id, values: {} },
      next_attempt_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    },
  });
  return { runId: run.run_id, threadId: thread.thread_id, delivery };
}

async function harness() {
  const deps = createFixtureDeps();
  const context = createContext(deps);
  const service = createProtocolServiceFromContext(context);
  await service.assistants.registerGraphAssistants();
  return { deps, service, handlers: createProtocolHandlers(service) };
}

describe("a run's deliveries", () => {
  it("lists them, newest first", async () => {
    const { deps, service } = await harness();
    const { runId } = await seedDelivery(service, deps);

    const listed = await service.runs.listDeliveries(runId);

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ run_id: runId, status: "delivering" });
  });

  it("404s an unknown run rather than answering with an empty list", async () => {
    const { service } = await harness();
    // An empty list would read as "this run has no callbacks" for a run that does not exist.
    await expect(service.runs.listDeliveries("nope")).rejects.toThrow(/not found/i);
  });

  // The payload is up to 256 KiB of the run's final state, per row. Returning it would make "what
  // failed?" the heaviest response the server can produce — and so would measuring it, which means
  // re-serializing every row to answer with a number nobody acts on.
  it("says whether a delivery is replayable rather than returning its payload", async () => {
    const { deps, service, handlers } = await harness();
    const { runId, threadId } = await seedDelivery(service, deps);

    const response = await handlers.listRunDeliveries({
      method: "GET",
      url: `http://localhost/threads/${threadId}/runs/${runId}/deliveries`,
      params: { thread_id: threadId, run_id: runId },
      query: {},
      headers: {},
      body: undefined,
    });

    expect(response.kind).toBe("json");
    const { deliveries } = (response as { body: { deliveries: Record<string, unknown>[] } }).body;
    expect(deliveries[0]).not.toHaveProperty("payload");
    expect(deliveries[0]?.["replayable"]).toBe(true);
  });

  it("filters by status", async () => {
    const { deps, service } = await harness();
    const { runId, delivery } = await seedDelivery(service, deps);
    await deps.store.deliveries!.recordAttempt(delivery.delivery_id, {
      outcome: "dead",
      error: "gave up",
    });

    expect(await service.runs.listDeliveries(runId, { status: "dead" })).toHaveLength(1);
    expect(await service.runs.listDeliveries(runId, { status: "delivered" })).toEqual([]);
  });

  it("makes a dead delivery due again", async () => {
    const { deps, service } = await harness();
    const { runId, delivery } = await seedDelivery(service, deps);
    await deps.store.deliveries!.recordAttempt(delivery.delivery_id, {
      outcome: "dead",
      error: "receiver was misconfigured",
    });

    const replayed = await service.runs.replayDelivery(runId, delivery.delivery_id);

    expect(replayed.status).toBe("pending");
    expect(new Date(replayed.next_attempt_at).getTime()).toBeLessThanOrEqual(Date.now());
  });

  // A delivered row has had its payload cleared, so there is genuinely nothing to resend. Answering
  // 200 would report a replay that cannot happen.
  it("409s a replay of a delivery that already succeeded", async () => {
    const { deps, service } = await harness();
    const { runId, delivery } = await seedDelivery(service, deps);
    await deps.store.deliveries!.recordAttempt(delivery.delivery_id, { outcome: "delivered" });

    await expect(service.runs.replayDelivery(runId, delivery.delivery_id)).rejects.toThrow(
      /nothing left to resend/,
    );
  });

  it("404s a replay of an unknown delivery", async () => {
    const { deps, service } = await harness();
    const { runId } = await seedDelivery(service, deps);

    await expect(service.runs.replayDelivery(runId, "nope")).rejects.toThrow(/not found/i);
  });

  // The path is `/runs/:run_id/deliveries/:delivery_id`, and both halves are checked. Without this a
  // delivery id would be a way to reach a callback belonging to a run the caller cannot see.
  it("refuses a delivery that belongs to a different run", async () => {
    const { deps, service } = await harness();
    const mine = await seedDelivery(service, deps);
    const theirs = await seedDelivery(service, deps);

    await expect(
      service.runs.replayDelivery(mine.runId, theirs.delivery.delivery_id),
    ).rejects.toThrow(/not found/i);
  });

  it("hands a replayed delivery straight to the queue when there is one", async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);
    const deps = createFixtureDeps({
      deliveryQueue: { schedule, consume: () => ({ close: async () => {} }), durable: true },
    });
    const service = createProtocolServiceFromContext(createContext(deps));
    await service.assistants.registerGraphAssistants();
    const { runId, delivery } = await seedDelivery(service, deps);
    await deps.store.deliveries!.recordAttempt(delivery.delivery_id, {
      outcome: "dead",
      error: "gave up",
    });

    await service.runs.replayDelivery(runId, delivery.delivery_id);

    // Immediate, rather than waiting for the recovery sweep to notice it — and `replace`, because a
    // delivery being replayed may still hold a delayed job from its original schedule, which would
    // make the add a silent no-op and leave the "immediate" replay waiting out the old backoff.
    expect(schedule).toHaveBeenCalledWith(
      { delivery_id: delivery.delivery_id },
      expect.objectContaining({ replace: true }),
    );
    // The full remaining budget, not BullMQ's default of one — otherwise a replay that fails once
    // goes straight back to `dead`.
    expect(schedule.mock.calls[0]![1].attempts).toBeGreaterThan(1);
  });

  it("still replays when the queue refuses the hand-off", async () => {
    const deps = createFixtureDeps({
      deliveryQueue: {
        schedule: vi.fn().mockRejectedValue(new Error("redis down")),
        consume: () => ({ close: async () => {} }),
        durable: true,
      },
    });
    const service = createProtocolServiceFromContext(createContext(deps));
    await service.assistants.registerGraphAssistants();
    const { runId, delivery } = await seedDelivery(service, deps);
    await deps.store.deliveries!.recordAttempt(delivery.delivery_id, {
      outcome: "dead",
      error: "gave up",
    });

    // The row is already `pending`, so the sweep will pick it up — failing the request would tell an
    // operator the replay did not happen when it merely will not be immediate.
    const replayed = await service.runs.replayDelivery(runId, delivery.delivery_id);
    expect(replayed.status).toBe("pending");
  });
});
