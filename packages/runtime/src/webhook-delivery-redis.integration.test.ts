// The production delivery path: Postgres for the outbox, BullMQ for the schedule.
//
// These cases exist to prove the division of labour actually holds at runtime, because it is the
// thing most easily broken by a later edit:
//
//   - the row is written in the run's transaction, so a callback is never *lost*;
//   - the retry is a BullMQ job, so it survives the process that created it;
//   - a job lost in the one window that exists (a crash between the outbox COMMIT and the enqueue)
//     is recovered by the sweep rather than by luck.
//
// Nothing here drives a clock forward by hand: BullMQ owns the timing, so the delays are real. They
// are kept small by configuring a short `initialDelayMs` rather than by waiting out the defaults.

import { createServer, type Server } from "node:http";

import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { createProtocolRuntime, type ProtocolDeps } from "@skein-js/agent-protocol";
import { RedisDeliveryQueue } from "@skein-js/redis";
import { startPostgres, startRedis, type StartedResource } from "@skein-js/test-support";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { embedPostgresGraphs } from "./embed-postgres-graphs.js";

function buildGraph() {
  return new StateGraph(MessagesAnnotation)
    .addNode("noop", () => ({ messages: [] }))
    .addEdge("__start__", "noop")
    .addEdge("noop", "__end__")
    .compile();
}

let pg: StartedResource;
let redis: StartedResource;

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
}, 180_000);

afterAll(async () => {
  await pg?.stop();
  await redis?.stop();
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

/** A receiver that refuses the first `failFirst` requests, then accepts. */
async function startReceiver(failFirst = 0) {
  const received: Record<string, unknown>[] = [];
  let refused = 0;
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      if (refused < failFirst) {
        refused += 1;
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
    refusals: () => refused,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  cleanup.push(() => receiver.close());
  return receiver;
}

/**
 * One server on the production drivers. `queueName` is per-test so BullMQ jobs cannot leak between
 * cases through the shared Redis.
 */
async function startInstance(queueName: string, overrides: Partial<ProtocolDeps> = {}) {
  const embedded = await embedPostgresGraphs(
    { echo: buildGraph() },
    {
      postgresUri: pg.url,
      redisUri: redis.url,
      overrides: {
        // Short delays so the real BullMQ schedule fits in a test rather than being simulated.
        webhooks: { retries: { maxAttempts: 6, initialDelayMs: 50 } },
        deliveryQueue: new RedisDeliveryQueue(redis.url, { queueName, initialDelayMs: 50 }),
        ...overrides,
      },
    },
  );
  const runtime = createProtocolRuntime(embedded.deps);
  await runtime.service.assistants.registerGraphAssistants();
  runtime.worker.start();
  cleanup.push(async () => {
    await runtime.worker.stop();
    await embedded.dispose();
  });
  return { runtime, deps: embedded.deps };
}

async function runWithWebhook(
  runtime: Awaited<ReturnType<typeof startInstance>>["runtime"],
  webhook: string,
): Promise<string> {
  const thread = await runtime.service.threads.create();
  const { runId } = await runtime.service.runs.createWait({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    input: { messages: [] },
    webhook,
  });
  return runId;
}

describe("durable outbound delivery — Postgres outbox, BullMQ schedule", () => {
  it("lets BullMQ retry a failed callback until the receiver recovers", async () => {
    const receiver = await startReceiver(3);
    const { runtime, deps } = await startInstance("skein-test-retry");

    const runId = await runWithWebhook(runtime, receiver.url);

    // The inline attempt failed, so the row is pending and a BullMQ job now owns the schedule. From
    // here nothing in skein decides when to try again.
    await vi.waitFor(async () => expect(receiver.received).toHaveLength(1), {
      timeout: 20_000,
      interval: 100,
    });

    expect(receiver.refusals()).toBe(3);
    expect(receiver.received[0]).toMatchObject({ run_id: runId, status: "success" });
    await vi.waitFor(
      async () => {
        const [settled] = await deps.store.deliveries!.listByRun(runId);
        expect(settled?.status).toBe("delivered");
      },
      { timeout: 10_000, interval: 100 },
    );
  }, 120_000);

  it("gives up after the configured attempts and records the dead letter in the store", async () => {
    // The receiver never recovers. The dead letter has to end up on the *row* — an operator looks at
    // skein's delivery list, not at BullMQ's failed set, and the replay endpoint reads the row.
    const receiver = await startReceiver(Number.MAX_SAFE_INTEGER);
    const { runtime, deps } = await startInstance("skein-test-dead");

    const runId = await runWithWebhook(runtime, receiver.url);

    await vi.waitFor(
      async () => {
        const [settled] = await deps.store.deliveries!.listByRun(runId);
        expect(settled?.status).toBe("dead");
      },
      { timeout: 30_000, interval: 200 },
    );

    const [dead] = await deps.store.deliveries!.listByRun(runId);
    expect(dead?.attempt).toBeGreaterThan(1);
    // Kept, so the replay endpoint has something to resend once the receiver is fixed.
    expect(dead?.payload).toMatchObject({ run_id: runId });
    expect(dead?.last_error).toBeTruthy();
  }, 120_000);

  it("delivers a callback whose retry outlived the instance that created it", async () => {
    // The property that makes this the production path: the schedule is in Redis, not in a timer that
    // dies with the process. Instance A fails the inline attempt and is torn down; instance B, which
    // never saw the run, picks the job up.
    const receiver = await startReceiver(1);
    const queueName = "skein-test-handover";
    const embeddedA = await embedPostgresGraphs(
      { echo: buildGraph() },
      {
        postgresUri: pg.url,
        redisUri: redis.url,
        overrides: {
          webhooks: { retries: { maxAttempts: 6, initialDelayMs: 2_000 } },
          deliveryQueue: new RedisDeliveryQueue(redis.url, { queueName, initialDelayMs: 2_000 }),
        },
      },
    );
    const runtimeA = createProtocolRuntime(embeddedA.deps);
    await runtimeA.service.assistants.registerGraphAssistants();
    const runId = await runWithWebhook(runtimeA, receiver.url);
    // A's inline attempt was refused, and the retry is queued but not yet due.
    expect(receiver.refusals()).toBe(1);
    expect(receiver.received).toHaveLength(0);
    // A goes away entirely — no worker, no consumer, no connections.
    await embeddedA.dispose();

    const { deps } = await startInstance(queueName);

    await vi.waitFor(async () => expect(receiver.received).toHaveLength(1), {
      timeout: 30_000,
      interval: 100,
    });
    expect(receiver.received[0]).toMatchObject({ run_id: runId });
    // Awaited rather than asserted straight away: the POST returning and the row being written are two
    // steps, and reading between them is a flake rather than a finding.
    await vi.waitFor(
      async () =>
        expect((await deps.store.deliveries!.listByRun(runId))[0]?.status).toBe("delivered"),
      { timeout: 10_000, interval: 100 },
    );
  }, 120_000);

  it("recovers a delivery whose job was never enqueued", async () => {
    // The one window the queue cannot cover, because a Redis `add()` cannot join the Postgres
    // transaction: the process died between the COMMIT and the enqueue. There is no job, so only the
    // sweep can find it — which is exactly what the sweep is for.
    const receiver = await startReceiver();
    const queueName = "skein-test-lost-job";
    const lostQueue = new RedisDeliveryQueue(redis.url, { queueName, initialDelayMs: 50 });
    // Scheduling silently does nothing: the enqueue that should have followed the COMMIT never ran.
    vi.spyOn(lostQueue, "schedule").mockResolvedValue(undefined);
    const embedded = await embedPostgresGraphs(
      { echo: buildGraph() },
      {
        postgresUri: pg.url,
        redisUri: redis.url,
        overrides: {
          webhooks: { retries: { maxAttempts: 6, initialDelayMs: 50 } },
          deliveryQueue: lostQueue,
          webhookDispatcher: () => Promise.reject(new Error("receiver refused the inline attempt")),
        },
      },
    );
    const runtime = createProtocolRuntime(embedded.deps);
    await runtime.service.assistants.registerGraphAssistants();
    let disposed = false;
    cleanup.push(async () => {
      if (!disposed) await embedded.dispose();
    });

    const thread = await runtime.service.threads.create();
    const { runId } = await runtime.service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { messages: [] },
      webhook: receiver.url,
    });

    const [orphan] = await embedded.deps.store.deliveries!.listByRun(runId);
    expect(orphan?.status).toBe("pending");
    expect(receiver.received).toHaveLength(0);
    // The dead instance goes away before the rescue. It was never started, so it never consumed —
    // which is itself the property being relied on: building a runtime must not start pulling work.
    await embedded.dispose();
    disposed = true;

    // A healthy instance sweeps: the row is due, no job exists, so it is handed back to the queue.
    //
    // Two minutes, not two hours. When a queue owns the schedule the row's `next_attempt_at` is the
    // queue's estimated next attempt plus a one-minute margin — short, because the sweep *reads*
    // rather than claims, so overlapping a job the queue is merely holding costs nothing. This is the
    // assertion that a lost enqueue is recovered on the next sweep pass rather than hours later.
    const dueAt = new Date(Date.now() + 120_000);
    const rescuer = await startInstance(queueName, { clock: () => dueAt });
    await rescuer.runtime.deliveryWorker.tickOnce();

    await vi.waitFor(async () => expect(receiver.received).toHaveLength(1), {
      timeout: 20_000,
      interval: 100,
    });
    expect(receiver.received[0]).toMatchObject({ run_id: runId });
  }, 120_000);
});
