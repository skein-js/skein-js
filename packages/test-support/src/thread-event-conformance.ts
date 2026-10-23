import { randomUUID } from "node:crypto";

import type { Thread, ThreadEventBus, ThreadEventInput } from "@skein-js/core";
import { describe, expect, it } from "vitest";

/** One behavior contract for process-local and cross-instance thread event implementations. */
export function runThreadEventBusConformance(
  name: string,
  factory: () => ThreadEventBus | Promise<ThreadEventBus>,
): void {
  const event = (runId: string): ThreadEventInput => ({
    kind: "protocol",
    runId,
    event: {
      type: "event",
      method: "values",
      params: { namespace: [], timestamp: 0, data: { runId } },
    },
  });
  const usingBus = async (body: (bus: ThreadEventBus, threadId: string) => Promise<void>) => {
    const bus = await factory();
    try {
      await body(bus, randomUUID());
    } finally {
      await (bus as ThreadEventBus & { dispose?(): Promise<void> }).dispose?.();
    }
  };

  describe(`${name} thread event conformance`, () => {
    it("assigns replay identities across runs and tails without a gap", () =>
      usingBus(async (bus, id) => {
        const first = await bus.publish(id, event("run-a"));
        const second = await bus.publish(id, event("run-b"));
        expect([first?.seq, second?.seq]).toEqual([1, 2]);
        expect(await bus.replayCursor(id)).toBe(0);
        const iterator = bus.subscribe(id, 1)[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toMatchObject({
          seq: 2,
          kind: "protocol",
          runId: "run-b",
          event: { seq: 2, event_id: "2", params: { namespace: [] } },
        });
        const next = iterator.next();
        await bus.publish(id, event("run-c"));
        expect((await next).value.seq).toBe(3);
        await iterator.return?.();
      }));

    it("does not advance sequences or reopen deleted threads when serialization fails", () =>
      usingBus(async (bus, id) => {
        const circular: Record<string, unknown> = {};
        circular["self"] = circular;
        await expect(
          bus.publish(id, {
            kind: "run",
            runId: "invalid",
            frame: { seq: 0, event: "values", data: circular },
          }),
        ).rejects.toThrow();
        expect(await bus.latestSequence(id)).toBe(0);
        expect((await bus.publish(id, event("valid")))?.seq).toBe(1);
        await bus.deleteThread(id);
        await expect(
          bus.publish(id, {
            kind: "state",
            operation: "created",
            thread: {
              thread_id: id,
              created_at: "2026-10-23T00:00:00Z",
              updated_at: "2026-10-23T00:00:00Z",
              state_updated_at: "2026-10-23T00:00:00Z",
              interrupts: {},
              metadata: {},
              status: "idle",
              values: circular,
            },
          }),
        ).rejects.toThrow();
        expect(await bus.latestSequence(id)).toBe(1);
        expect(await bus.publish(id, event("late"))).toBeUndefined();
      }));

    it("keeps independently cancellable readers", () =>
      usingBus(async (bus, id) => {
        const first = bus.subscribe(id)[Symbol.asyncIterator]();
        const second = bus.subscribe(id)[Symbol.asyncIterator]();
        const a = first.next();
        const b = second.next();
        await bus.publish(id, event("one"));
        expect((await a).value.seq).toBe(1);
        expect((await b).value.seq).toBe(1);
        const waiting = first.next();
        await first.return?.();
        expect((await waiting).done).toBe(true);
        await bus.publish(id, event("two"));
        expect((await second.next()).value.seq).toBe(2);
        await second.return?.();
      }));

    it("rejects future cursors", () =>
      usingBus(async (bus, id) => {
        await expect(bus.subscribe(id, 100)[Symbol.asyncIterator]().next()).rejects.toMatchObject({
          code: "thread_cursor_expired",
        });
      }));

    it("erases events and rejects late publishers until a new thread is explicitly created", () =>
      usingBus(async (bus, id) => {
        const generation = await bus.generation(id);
        await bus.publish(id, event("old"), generation);
        await bus.deleteThread(id);
        expect(await bus.publish(id, event("old"))).toBeUndefined();
        const thread = {
          thread_id: id,
          created_at: "2026-10-22T00:00:00Z",
          updated_at: "2026-10-22T00:00:00Z",
          metadata: {},
          status: "idle",
          values: {},
        } as Thread;
        expect(
          await bus.publish(id, { kind: "state", operation: "created", thread }, generation),
        ).toBeUndefined();
        expect((await bus.publish(id, { kind: "state", operation: "created", thread }))?.seq).toBe(
          2,
        );
        expect(await bus.publish(id, event("old"), generation)).toBeUndefined();
        const iterator = bus.subscribe(id)[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toMatchObject({ kind: "state", seq: 2 });
        await iterator.return?.();
      }));

    it("serializes concurrent producers in the same order readers replay", () =>
      usingBus(async (bus, id) => {
        await Promise.all(Array.from({ length: 40 }, (_, i) => bus.publish(id, event(`run-${i}`))));
        const iterator = bus.subscribe(id)[Symbol.asyncIterator]();
        const sequences = [];
        for (let i = 0; i < 40; i++) sequences.push((await iterator.next()).value.seq);
        expect(sequences).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
        await iterator.return?.();
      }));
  });
}
