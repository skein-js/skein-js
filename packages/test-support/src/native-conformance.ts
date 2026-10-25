import { randomUUID } from "node:crypto";

import { runError, type AdmissionKey, type DeliveryCreate, type SkeinStore } from "@skein-js/core";
import { describe, expect, it } from "vitest";

const now = "2026-10-25T00:00:00.000Z";
const later = "2026-10-26T00:00:00.000Z";
const identity = (key = randomUUID()): AdmissionKey => ({
  scope: "native-conformance",
  key,
  fingerprint: "one",
  now,
  expiresAt: later,
});

export function runNativeConformance(makeStore: () => SkeinStore | Promise<SkeinStore>): void {
  describe("optional atomic native admission", () => {
    it("does not mutate a pre-aborted admission or persist its signal", async () => {
      const store = await makeStore();
      if (!store.admission) return;
      const thread = await store.threads.create();
      const controller = new AbortController();
      controller.abort(new Error("lease lost"));
      const input = {
        ...identity(),
        run: { thread_id: thread.thread_id, assistant_id: "a" },
        guard: {},
        signal: controller.signal,
      };
      await expect(store.admission.admitRun(input)).rejects.toThrow("lease lost");
      expect(await store.runs.listByThread(thread.thread_id)).toHaveLength(0);
      expect(await store.idempotency.get(input.scope, input.key)).toBeNull();
      expect(await store.admission.claimDispatches({ now, leaseUntil: later })).toHaveLength(0);
    });
    it("commits one receipt/run/dispatch intent under concurrent retries and rejects changed input", async () => {
      const store = await makeStore();
      if (!store.admission) return;
      expect(typeof store.runs.settle).toBe("function");
      const thread = await store.threads.create();
      const input = {
        ...identity(),
        run: { thread_id: thread.thread_id, assistant_id: "a", kwargs: { queue_not_before: now } },
        guard: { requireNoActiveRun: true },
      };
      const receipts = await Promise.all(
        Array.from({ length: 8 }, () => store.admission!.admitRun(input)),
      );
      expect(new Set(receipts.map((receipt) => receipt.runId)).size).toBe(1);
      expect(await store.runs.listByThread(thread.thread_id)).toHaveLength(1);
      expect(await store.idempotency.get(input.scope, input.key)).toMatchObject({
        run_id: receipts[0]!.runId,
        status: "done",
      });
      await expect(
        store.admission.admitRun({ ...input, fingerprint: "changed" }),
      ).rejects.toMatchObject({ code: "idempotency_key_reused" });
      const claims = await store.admission.claimDispatches({ now, leaseUntil: later });
      expect(claims).toHaveLength(1);
      await store.admission.markDispatched(claims[0]!.runId, "wrong-token");
      expect(await store.admission.claimDispatches({ now, leaseUntil: later })).toHaveLength(0);
      const reclaimed = await store.admission.claimDispatches({
        now: later,
        leaseUntil: "2026-10-27T00:00:00.000Z",
      });
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]!.token).not.toBe(claims[0]!.token);
      await store.admission.markDispatched(claims[0]!.runId, claims[0]!.token);
      const third = await store.admission.claimDispatches({
        now: "2026-10-28T00:00:00.000Z",
        leaseUntil: "2026-10-29T00:00:00.000Z",
      });
      expect(third).toHaveLength(1);
      await store.admission.markDispatched(third[0]!.runId, third[0]!.token);
      // ACK suppresses an immediate retry; ownership survives queue job loss after that ACK.
      expect(
        await store.admission.claimDispatches({
          now: "2026-10-28T00:00:00.000Z",
          leaseUntil: "2026-10-29T00:00:00.000Z",
        }),
      ).toHaveLength(0);
      const recovered = await store.admission.claimDispatches({
        now: "2026-10-30T00:00:00.000Z",
        leaseUntil: "2026-10-31T00:00:00.000Z",
      });
      expect(recovered).toHaveLength(1);
      await store.runs.settle!(receipts[0]!.runId, {
        status: "cancelled",
        error: runError("Cancelled", "retained"),
      });
      expect(
        await store.admission.claimDispatches({
          now: "2026-11-01T00:00:00.000Z",
          leaseUntil: "2026-11-02T00:00:00.000Z",
        }),
      ).toHaveLength(0);
      // Even a terminal recovery scan must retain the guard against reopening admitted work.
      const cancelled = await store.runs.get(receipts[0]!.runId);
      expect(await store.runs.setStatus(receipts[0]!.runId, "running")).toEqual(cancelled);
      // Legacy rows retain their existing setter contract and are never adopted by recovery.
      const ordinary = await store.runs.create({
        thread_id: thread.thread_id,
        assistant_id: "a",
        status: "success",
      });
      expect((await store.runs.setStatus(ordinary.run_id, "running")).status).toBe("running");
      expect(
        await store.admission.claimDispatches({
          now: "2026-11-03T00:00:00.000Z",
          leaseUntil: "2026-11-04T00:00:00.000Z",
        }),
      ).toHaveLength(0);
    });

    it("reserves the expected predecessor independently of receipt expiry", async () => {
      const store = await makeStore();
      if (!store.admission) return;
      const thread = await store.threads.create();
      const previous = await store.runs.create({
        thread_id: thread.thread_id,
        assistant_id: "a",
        status: "interrupted",
      });
      await store.threads.update(thread.thread_id, { status: "interrupted" });
      const first = await store.admission.admitRun({
        ...identity(),
        run: { thread_id: thread.thread_id, assistant_id: "a" },
        guard: { requireNoActiveRun: true },
        expectedRunId: previous.run_id,
      });
      await store.runs.setStatus(first.runId, "success");
      await store.idempotency.sweepExpired(later);
      await expect(
        store.admission.admitRun({
          ...identity(),
          now: later,
          expiresAt: "2026-10-27T00:00:00.000Z",
          run: { thread_id: thread.thread_id, assistant_id: "a" },
          guard: { requireNoActiveRun: true },
          expectedRunId: previous.run_id,
        }),
      ).rejects.toMatchObject({ code: "stale_resume" });
      expect(await store.runs.listByThread(thread.thread_id)).toHaveLength(2);
    });

    it("settles output and one identified delivery without replacing the winning terminal status", async () => {
      const store = await makeStore();
      if (!store.runs.settle) return;
      const thread = await store.threads.create();
      const run = await store.runs.create({ thread_id: thread.thread_id, assistant_id: "a" });
      const delivery: DeliveryCreate = {
        delivery_id: randomUUID(),
        thread_id: thread.thread_id,
        url: "https://example.test/outcome",
        payload: { answer: "first" },
        next_attempt_at: now,
        expires_at: later,
      };
      const first = await store.runs.settle(run.run_id, {
        status: "success",
        result: { values: { answer: "first" } },
        delivery,
      });
      expect(first.run?.status).toBe("success");
      expect(first.delivery).toMatchObject({ status: "pending", attempt: 0 });
      await store.runs.settle(run.run_id, {
        status: "cancelled",
        result: { values: { answer: "wrong" } },
        delivery,
      });
      expect(await store.runs.getResult!(run.run_id)).toEqual({ values: { answer: "first" } });
      expect(await store.deliveries!.listByRun(run.run_id)).toHaveLength(1);
      expect((await store.deliveries!.listByRun(run.run_id))[0]!.run_status).toBe("success");
      await store.runs.delete(run.run_id);
      await store.runs.settle(run.run_id, {
        status: "success",
        result: { values: { answer: "late" } },
      });
      expect(await store.runs.getResult!(run.run_id)).toBeNull();
    });

    it("rolls back a malformed admission before leaving receipt or dispatch state", async () => {
      const store = await makeStore();
      if (!store.admission) return;
      const thread = await store.threads.create();
      const input = {
        ...identity(),
        run: { thread_id: thread.thread_id, assistant_id: "a", kwargs: { input: BigInt(42) } },
        guard: {},
      };
      await expect(store.admission.admitRun(input)).rejects.toThrow();
      expect(await store.runs.listByThread(thread.thread_id)).toHaveLength(0);
      expect(await store.idempotency.get(input.scope, input.key)).toBeNull();
      expect(await store.admission.claimDispatches({ now, leaseUntil: later })).toHaveLength(0);
    });
  });
}
