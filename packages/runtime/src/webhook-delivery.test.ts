// Success criterion 1 for durable outbound delivery, on the driver combination that needs no Docker:
//
//   "An integration test kills the receiver for 60 seconds mid-suite; every notification still
//    arrives, none marked `dead`."
//
// A real `node:http` receiver on loopback rather than a mocked dispatcher, so the default
// `fetch`-based dispatcher, the retry classification and the outbox all run for real — a mock would
// prove only that we call our own function. Time is injected and the runtime's own delivery worker is
// driven with `tickOnce()`, so the sixty seconds pass instantly and nothing here waits on a timer.
//
// The Postgres + Redis half of the criterion, and the crash window itself, are in
// `webhook-delivery.integration.test.ts`.

import { createServer, type Server } from "node:http";

import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import {
  createProtocolRuntime,
  DEFAULT_MAX_ATTEMPTS,
  type ProtocolDeps,
} from "@skein-js/agent-protocol";
import { embedInMemoryGraphs } from "@skein-js/server-kit";
import { afterEach, describe, expect, it } from "vitest";

/** A graph that settles immediately — these tests are about delivery, not execution. */
function buildGraph() {
  return new StateGraph(MessagesAnnotation)
    .addNode("noop", () => ({ messages: [] }))
    .addEdge("__start__", "noop")
    .addEdge("noop", "__end__")
    .compile();
}

interface Receiver {
  url: string;
  /** Bodies actually received, in order. */
  received: Record<string, unknown>[];
  /** While true, every request is refused with a 503 — the receiver is "down". */
  down: boolean;
  close(): Promise<void>;
}

async function startReceiver(): Promise<Receiver> {
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
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    get down() {
      return state.down;
    },
    set down(value: boolean) {
      state.down = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

/** A movable clock, so a sixty-second outage costs the suite nothing. */
function movableClock(from = new Date("2026-01-01T00:00:00.000Z")) {
  let now = from.getTime();
  return {
    clock: (): Date => new Date(now),
    advance: (ms: number): void => {
      now += ms;
    },
    nowMs: (): number => now,
  };
}

/** An in-process server over the memory drivers, with `clock` (and any policy) injected. */
async function startServer(overrides: Partial<ProtocolDeps>) {
  const deps = embedInMemoryGraphs({ echo: buildGraph() }, overrides);
  const runtime = createProtocolRuntime(deps);
  await runtime.service.assistants.registerGraphAssistants();
  return { runtime, deps };
}

/** Run one graph to completion, asking for a callback at `webhook`. */
async function runWithWebhook(
  runtime: Awaited<ReturnType<typeof startServer>>["runtime"],
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

describe("durable outbound delivery — memory store, in-memory queue, no Docker", () => {
  it("delivers a notification through a 60-second receiver outage, and never gives up", async () => {
    const receiver = await startReceiver();
    cleanup.push(() => receiver.close());
    const { clock, advance, nowMs } = movableClock();
    const { runtime, deps } = await startServer({ clock });

    receiver.down = true;
    const runId = await runWithWebhook(runtime, receiver.url);

    // The run itself is unaffected by the receiver being down — that has always been true, and it is
    // exactly why the notification used to vanish without trace.
    expect(receiver.received).toHaveLength(0);
    const [pending] = await deps.store.deliveries!.listByRun(runId);
    expect(pending?.status).toBe("pending");

    // Sixty seconds of outage, walked forward one tick at a time.
    const outageStart = nowMs();
    while (nowMs() - outageStart < 60_000) {
      advance(5_000);
      await runtime.deliveryWorker.tickOnce();
    }
    expect(receiver.received).toHaveLength(0);

    receiver.down = false;
    for (const _ of [0, 1, 2, 3]) {
      advance(30_000);
      await runtime.deliveryWorker.tickOnce();
    }

    // Exactly one body arrived — retried, not duplicated.
    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0]).toMatchObject({ run_id: runId, status: "success" });
    const [settled] = await deps.store.deliveries!.listByRun(runId);
    expect(settled?.status).toBe("delivered");
    expect(settled?.attempt).toBeLessThan(DEFAULT_MAX_ATTEMPTS);
    // The criterion's sharpest clause: nothing gave up.
    expect(await deps.store.deliveries!.listByRun(runId, { status: "dead" })).toEqual([]);
  });

  it("delivers every one of a burst of runs that rode out the same outage", async () => {
    const receiver = await startReceiver();
    cleanup.push(() => receiver.close());
    const { clock, advance } = movableClock();
    const { runtime } = await startServer({ clock });

    receiver.down = true;
    const runIds: string[] = [];
    for (const _ of [0, 1, 2, 3, 4]) runIds.push(await runWithWebhook(runtime, receiver.url));

    for (const _ of [0, 1, 2, 3, 4, 5, 6]) {
      advance(15_000);
      await runtime.deliveryWorker.tickOnce();
    }
    receiver.down = false;
    for (const _ of [0, 1, 2, 3, 4]) {
      advance(60_000);
      await runtime.deliveryWorker.tickOnce();
    }

    // Every run, exactly once each. A backlog that drops one is the failure this change exists to
    // make impossible; a backlog that sends one twice is the failure the delivery id absorbs.
    expect(receiver.received).toHaveLength(runIds.length);
    expect(new Set(receiver.received.map((body) => body["run_id"]))).toEqual(new Set(runIds));
  });

  it("stops after the configured attempts and keeps the payload for a replay", async () => {
    const receiver = await startReceiver();
    cleanup.push(() => receiver.close());
    receiver.down = true;
    const { clock, advance } = movableClock();
    const webhooks = { retries: { maxAttempts: 3, initialDelayMs: 1_000 } };
    const { runtime, deps } = await startServer({ clock, webhooks });

    const runId = await runWithWebhook(runtime, receiver.url);
    for (const _ of [0, 1, 2, 3]) {
      advance(30_000);
      await runtime.deliveryWorker.tickOnce();
    }

    const [dead] = await deps.store.deliveries!.listByRun(runId);
    expect(dead?.status).toBe("dead");
    expect(dead?.attempt).toBe(3);
    // Kept, so a replay has something to resend once the receiver is fixed — a dead letter you
    // cannot replay is a log line.
    expect(dead?.payload).toMatchObject({ run_id: runId });
  });

  it("refuses a callback to a host outside the allowlist, visibly", async () => {
    const receiver = await startReceiver();
    cleanup.push(() => receiver.close());
    const { clock } = movableClock();
    const { runtime, deps } = await startServer({
      clock,
      webhooks: { allowedHosts: ["hooks.allowed.test"] },
    });

    const runId = await runWithWebhook(runtime, receiver.url);

    expect(receiver.received).toHaveLength(0);
    const [refused] = await deps.store.deliveries!.listByRun(runId);
    // Recorded as dead rather than silently skipped: an operator can see a callback was owed and why
    // it was not sent, instead of wondering why one never arrived.
    expect(refused?.status).toBe("dead");
    expect(refused?.last_error).toContain("allowed_hosts");
  });
});
