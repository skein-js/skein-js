import { Annotation, StateGraph, interrupt } from "@langchain/langgraph";
import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { MemoryRunQueue } from "@skein-js/storage-memory";
import { startPostgres, startRedis, type StartedResource } from "@skein-js/test-support";
import { afterAll, beforeAll, expect, it } from "vitest";

import { embedPostgresGraphs } from "./embed-postgres-graphs.js";

let postgres: StartedResource;
let redis: StartedResource;
beforeAll(async () => {
  [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
}, 120_000);
afterAll(async () => {
  await Promise.allSettled([postgres?.stop(), redis?.stop()]);
});

it("two replicas reserve one answer and recover admission after producer enqueue failure", async () => {
  const state = Annotation.Root({ answer: Annotation<string> });
  const graph = new StateGraph(state)
    .addNode("approve", () => ({ answer: interrupt("approve?") }))
    .addEdge("__start__", "approve")
    .addEdge("approve", "__end__")
    .compile();
  const assemblies = await Promise.all(
    [0, 1].map(() =>
      embedPostgresGraphs({ approval: graph }, { postgresUri: postgres.url, redisUri: redis.url }),
    ),
  );
  const runtimes = assemblies.map(({ deps }) =>
    createProtocolRuntime(deps, { scheduler: { enabled: false } }),
  );
  const clients = runtimes.map((runtime) =>
    runtime.createNativeClient({
      sourceId: "replicas",
      allowedAssistants: ["approval"],
      outcomeTarget: "https://receiver.example/native",
    }),
  );
  try {
    await runtimes[0]!.service.assistants.registerGraphAssistants();
    const enqueue = assemblies[0]!.deps.queue.enqueue.bind(assemblies[0]!.deps.queue);
    assemblies[0]!.deps.queue.enqueue = async () => {
      throw new Error("producer lost Redis after COMMIT");
    };
    const first = await clients[0]!.start(
      { assistant_id: "approval", input: {} },
      { idempotencyKey: "original" },
    );
    assemblies[0]!.deps.queue.enqueue = enqueue;
    runtimes[1]!.worker.start();
    await expect
      .poll(async () => (await clients[1]!.getRun(first.runId)).status, { timeout: 10_000 })
      .toBe("interrupted");
    const checkpoint = (await clients[1]!.getResult(first.runId)).checkpoint!;
    const input = {
      assistant_id: "approval",
      thread_id: first.threadId,
      expected: { runId: first.runId, checkpoint },
      resume: "approved",
    };
    const answers = await Promise.allSettled(
      clients.map((client, index) => client.resume(input, { idempotencyKey: `answer-${index}` })),
    );
    expect(answers.filter((answer) => answer.status === "fulfilled")).toHaveLength(1);
    const accepted = answers.find((answer) => answer.status === "fulfilled");
    if (accepted?.status !== "fulfilled") throw new Error("No admitted answer");
    await expect
      .poll(async () => (await clients[0]!.getRun(accepted.value.runId)).status, {
        timeout: 10_000,
      })
      .toBe("success");
    expect((await clients[0]!.getResult(accepted.value.runId)).values).toEqual({
      answer: "approved",
    });
    expect(await assemblies[0]!.deps.store.runs.listByThread(first.threadId)).toHaveLength(2);
    expect(await clients[1]!.getReceipt("original")).toEqual(first);
    expect(await assemblies[0]!.deps.store.deliveries!.listByRun(first.runId)).toHaveLength(1);
  } finally {
    await Promise.all(runtimes.map((runtime) => runtime.worker.stop()));
    await Promise.all(assemblies.map((assembly) => assembly.dispose()));
  }
}, 30_000);

it("serializes a state write with resume admission and rejects the checkpoint it displaced", async () => {
  const state = Annotation.Root({ answer: Annotation<string> });
  const graph = new StateGraph(state)
    .addNode("approve", () => ({ answer: interrupt("approve?") }))
    .addEdge("__start__", "approve")
    .addEdge("approve", "__end__")
    .compile();
  const assemblies = await Promise.all(
    [0, 1].map(() =>
      embedPostgresGraphs({ stateRace: graph }, { postgresUri: postgres.url, redisUri: redis.url }),
    ),
  );
  const runtimes = assemblies.map(({ deps }) =>
    createProtocolRuntime(deps, { scheduler: { enabled: false } }),
  );
  let enterWrite!: () => void;
  let releaseWrite!: () => void;
  const entered = new Promise<void>((resolve) => {
    enterWrite = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const saver = assemblies[1]!.deps.checkpointer;
  const put = saver.put.bind(saver);
  const client = runtimes[0]!.createNativeClient({
    sourceId: "state-race",
    allowedAssistants: ["stateRace"],
  });
  try {
    await runtimes[0]!.service.assistants.registerGraphAssistants();
    runtimes[0]!.worker.start();
    const receipt = await client.start({ assistant_id: "stateRace", input: {} });
    await expect
      .poll(async () => (await client.getRun(receipt.runId)).status, { timeout: 10_000 })
      .toBe("interrupted");
    const checkpoint = (await client.getResult(receipt.runId)).checkpoint!;
    saver.put = async (...args) => {
      enterWrite();
      await released;
      return put(...args);
    };
    const write = runtimes[1]!.service.threads.updateState(receipt.threadId, {
      values: { answer: "manual" },
    });
    await entered;
    let answerFinished = false;
    const answer = expect(
      client
        .resume(
          {
            assistant_id: "stateRace",
            thread_id: receipt.threadId,
            expected: { runId: receipt.runId, checkpoint },
            resume: "old answer",
          },
          { idempotencyKey: "stale-after-write" },
        )
        .finally(() => {
          answerFinished = true;
        }),
    ).rejects.toMatchObject({ code: "stale_resume" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(answerFinished).toBe(false);
    releaseWrite();
    expect((await write).checkpoint.checkpoint_id).not.toBe(checkpoint.checkpoint_id);
    await answer;
    expect(await assemblies[0]!.deps.store.runs.listByThread(receipt.threadId)).toHaveLength(1);
    await expect(client.getReceipt("stale-after-write")).rejects.toMatchObject({
      code: "receipt_unavailable",
    });
  } finally {
    releaseWrite();
    saver.put = put;
    await Promise.all(runtimes.map((runtime) => runtime.worker.stop()));
    await Promise.all(assemblies.map((assembly) => assembly.dispose()));
  }
}, 30_000);

it("recovers an acknowledged job lost with its queue without adopting an unrelated pending run", async () => {
  let invocations = 0;
  const state = Annotation.Root({ answer: Annotation<string> });
  const graph = new StateGraph(state)
    .addNode("execute", () => {
      invocations++;
      return { answer: "recovered" };
    })
    .addEdge("__start__", "execute")
    .addEdge("execute", "__end__")
    .compile();
  const assembly = await embedPostgresGraphs(
    { recover: graph },
    { postgresUri: postgres.url, redisUri: redis.url },
  );
  // A real Postgres store with a process-local execution queue is a supported embedded deployment.
  const original = createProtocolRuntime(
    { ...assembly.deps, queue: new MemoryRunQueue() },
    { scheduler: { enabled: false } },
  );
  const recoveredQueue = new MemoryRunQueue();
  const recovered = createProtocolRuntime(
    { ...assembly.deps, queue: recoveredQueue, clock: () => new Date(Date.now() + 60_000) },
    { scheduler: { enabled: false } },
  );
  const source = { sourceId: "lost-queue", allowedAssistants: ["recover"] };
  const client = original.createNativeClient(source);
  try {
    await original.service.assistants.registerGraphAssistants();
    const receipt = await client.start(
      { assistant_id: "recover", input: {} },
      { idempotencyKey: "accepted" },
    );
    const now = new Date();
    const claims = await assembly.deps.store.admission!.claimDispatches({
      now: now.toISOString(),
      leaseUntil: new Date(now.getTime() + 30_000).toISOString(),
    });
    const claim = claims.find((item) => item.runId === receipt.runId)!;
    expect(claim).toBeDefined();
    await assembly.deps.store.admission!.markDispatched(claim.runId, claim.token);
    const unrelatedThread = await assembly.deps.store.threads.create();
    const unrelated = await assembly.deps.store.runs.create({
      thread_id: unrelatedThread.thread_id,
      assistant_id: "recover",
      kwargs: { input: {} },
    });
    // The old queue and its ACKed job are abandoned; only persistent admission ownership can recover it.
    recovered.worker.start();
    await expect
      .poll(async () => (await client.getRun(receipt.runId)).status, { timeout: 10_000 })
      .toBe("success");
    expect(await recovered.createNativeClient(source).getReceipt("accepted")).toEqual(receipt);
    expect((await client.getResult(receipt.runId)).values).toEqual({ answer: "recovered" });
    expect((await assembly.deps.store.runs.get(unrelated.run_id))?.status).toBe("pending");
    await recoveredQueue.enqueue({ run_id: receipt.runId, thread_id: receipt.threadId });
    await recovered.worker.stop();
    expect(invocations).toBe(1);
  } finally {
    await Promise.all([original.worker.stop(), recovered.worker.stop()]);
    await assembly.dispose();
  }
}, 30_000);
