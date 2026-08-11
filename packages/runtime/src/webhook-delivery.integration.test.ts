// Durable outbound delivery on **Postgres with no Redis** — the shape `embedPostgresGraphs` documents
// as "a single durable instance", and the one where skein's own polling path is the retry mechanism
// rather than BullMQ's. (The production Postgres + Redis path is
// `webhook-delivery-redis.integration.test.ts`; the no-Docker path is `webhook-delivery.test.ts`.)
//
// This combination is worth its own suite because it is the one where the *store* alone carries every
// guarantee: the delivery row is written in the run's transaction, `claimDue` hands it to exactly one
// worker, and the lease on `next_attempt_at` is what recovers a delivery whose process died mid-POST.
// With Redis, BullMQ owns all three of those; here nothing does but the database.
//
// Two *separate* `embedPostgresGraphs` assemblies — separate pools, separate runtimes, separate
// delivery workers — sharing one database, exactly as `idempotency.integration.test.ts` does. That
// separation is the whole point: instance A records the delivery and dies; instance B, which has
// never heard of that run, is the one that delivers it. **This suite fails on `main` by construction,
// because on `main` there is no row for B to find.**

import { createServer, type Server } from "node:http";

import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { createProtocolRuntime, deliveryLeaseMs } from "@skein-js/agent-protocol";
import type { ProtocolDeps } from "@skein-js/agent-protocol";
import { startPostgres, type StartedResource } from "@skein-js/test-support";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { embedPostgresGraphs } from "./embed-postgres-graphs.js";

function buildGraph() {
  return new StateGraph(MessagesAnnotation)
    .addNode("noop", () => ({ messages: [] }))
    .addEdge("__start__", "noop")
    .addEdge("noop", "__end__")
    .compile();
}

let pg: StartedResource;

beforeAll(async () => {
  pg = await startPostgres();
}, 180_000);

afterAll(async () => {
  await pg?.stop();
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

/** A receiver that records what it is told, and can be taken down. */
async function startReceiver() {
  const received: Record<string, unknown>[] = [];
  const state = { down: false };
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      if (state.down) {
        response.writeHead(503).end();
        return;
      }
      received.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const receiver = {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    setDown: (value: boolean) => {
      state.down = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  cleanup.push(() => receiver.close());
  return receiver;
}

/** One server: its own pool, its own runtime, its own delivery worker. */
async function startInstance(overrides: Partial<ProtocolDeps> = {}) {
  // Deliberately no `redisUri`: with one, the retry schedule would be BullMQ's and none of the
  // store-side machinery below would be exercised.
  const embedded = await embedPostgresGraphs(
    { echo: buildGraph() },
    { postgresUri: pg.url, overrides },
  );
  const runtime = createProtocolRuntime(embedded.deps);
  await runtime.service.assistants.registerGraphAssistants();
  cleanup.push(() => embedded.dispose());
  return { runtime, deps: embedded.deps };
}

const fixedClock =
  (at: Date): (() => Date) =>
  () =>
    new Date(at);

describe("durable outbound delivery — Postgres store, no Redis, two instances", () => {
  it("hands a delivery whose process died mid-POST to another instance", async () => {
    const receiver = await startReceiver();
    const diedAt = new Date("2026-01-01T00:00:00.000Z");

    // Instance A: the callback is recorded in the run's finalize transaction, the inline attempt is
    // made — and then the process dies before it can record the outcome. Simulated by failing both
    // the POST and the write that would have recorded the failure, which is precisely the state a
    // SIGKILL between them leaves behind: a `delivering` row holding a lease nobody will ever release.
    const instanceA = await startInstance({
      clock: fixedClock(diedAt),
      webhookDispatcher: () => Promise.reject(new Error("process died mid-POST")),
    });
    const originalRecord = instanceA.deps.store.deliveries!.recordAttempt.bind(
      instanceA.deps.store.deliveries,
    );
    instanceA.deps.store.deliveries!.recordAttempt = () =>
      Promise.reject(new Error("process died before recording"));

    const thread = await instanceA.runtime.service.threads.create();
    const { runId } = await instanceA.runtime.service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { messages: [] },
      webhook: receiver.url,
    });

    // The run succeeded and reports so — which on `main` is the whole bug: a `success` run whose
    // notification is gone with no record that it was ever owed.
    expect((await instanceA.deps.store.runs.get(runId))?.status).toBe("success");
    const [orphan] = await instanceA.deps.store.deliveries!.listByRun(runId);
    expect(orphan).toMatchObject({ run_id: runId, status: "delivering", attempt: 1 });
    expect(receiver.received).toHaveLength(0);
    instanceA.deps.store.deliveries!.recordAttempt = originalRecord;

    // The engine's inline attempt is a batch of one, so that is the lease it took.
    const lease = deliveryLeaseMs(1, 5_000);
    // Instance B has never heard of this run. It finds the delivery only because the lease lapsed.
    const instanceB = await startInstance({
      clock: fixedClock(new Date(diedAt.getTime() + lease + 1_000)),
    });
    // Before the lease lapses, B must not touch it — or a slow POST would go out twice.
    const early = await startInstance({
      clock: fixedClock(new Date(diedAt.getTime() + lease - 1_000)),
    });
    expect(await early.runtime.deliveryWorker.tickOnce()).toMatchObject({ claimed: 0 });

    expect(await instanceB.runtime.deliveryWorker.tickOnce()).toMatchObject({
      claimed: 1,
      delivered: 1,
    });

    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0]).toMatchObject({ run_id: runId, status: "success" });
    const [settled] = await instanceB.deps.store.deliveries!.listByRun(runId);
    expect(settled?.status).toBe("delivered");
    // Cleared on delivery, so storage stays proportional to in-flight deliveries rather than to
    // every delivery this deployment has ever made.
    expect(settled?.payload).toBeNull();
  }, 120_000);

  it("does not let two instances' workers deliver the same row twice", async () => {
    const receiver = await startReceiver();
    receiver.setDown(true);
    const at = new Date("2026-02-01T00:00:00.000Z");
    const producer = await startInstance({ clock: fixedClock(at) });

    const thread = await producer.runtime.service.threads.create();
    const { runId } = await producer.runtime.service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { messages: [] },
      webhook: receiver.url,
    });
    // The inline attempt failed against a receiver that is down; it is due again after its backoff.
    expect((await producer.deps.store.deliveries!.listByRun(runId))[0]?.status).toBe("pending");

    receiver.setDown(false);
    const later = fixedClock(new Date(at.getTime() + 600_000));
    const [first, second, third] = await Promise.all([
      startInstance({ clock: later }),
      startInstance({ clock: later }),
      startInstance({ clock: later }),
    ]);

    // Three workers, one due row, one POST. `FOR UPDATE SKIP LOCKED` is what makes this true against
    // other *connections* — an in-process mutex would pass a single-process test and fail here.
    const summaries = await Promise.all([
      first.runtime.deliveryWorker.tickOnce(),
      second.runtime.deliveryWorker.tickOnce(),
      third.runtime.deliveryWorker.tickOnce(),
    ]);

    expect(summaries.reduce((total, one) => total + one.claimed, 0)).toBe(1);
    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0]).toMatchObject({ run_id: runId });
  }, 120_000);

  it("survives a receiver that is down for a minute, on the durable store", async () => {
    const receiver = await startReceiver();
    receiver.setDown(true);
    const at = new Date("2026-03-01T00:00:00.000Z");
    const producer = await startInstance({ clock: fixedClock(at) });

    const thread = await producer.runtime.service.threads.create();
    const { runId } = await producer.runtime.service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { messages: [] },
      webhook: receiver.url,
    });

    // Sixty seconds of outage, walked forward on a fresh instance per tick so the clock can move.
    for (const offsetMs of [5_000, 15_000, 30_000, 45_000, 60_000]) {
      const ticker = await startInstance({ clock: fixedClock(new Date(at.getTime() + offsetMs)) });
      await ticker.runtime.deliveryWorker.tickOnce();
    }
    expect(receiver.received).toHaveLength(0);
    expect(await producer.deps.store.deliveries!.listByRun(runId, { status: "dead" })).toEqual([]);

    receiver.setDown(false);
    const recovered = await startInstance({
      clock: fixedClock(new Date(at.getTime() + 300_000)),
    });
    await recovered.runtime.deliveryWorker.tickOnce();

    expect(receiver.received).toHaveLength(1);
    expect((await producer.deps.store.deliveries!.listByRun(runId))[0]?.status).toBe("delivered");
  }, 180_000);
});
