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

it("rejects an old child checkpoint map on real Postgres without replaying preparation", async () => {
  const state = Annotation.Root({ answer: Annotation<string> });
  let preparations = 0;
  const child = new StateGraph(state)
    .addNode("prepare", () => {
      preparations++;
      return {};
    })
    .addNode("ask", () => ({ answer: interrupt("approve?") }))
    .addEdge("__start__", "prepare")
    .addEdge("prepare", "ask")
    .addEdge("ask", "__end__")
    .compile();
  const graph = new StateGraph(state)
    .addNode("child", child)
    .addEdge("__start__", "child")
    .addEdge("child", "__end__")
    .compile();
  const assembly = await embedPostgresGraphs(
    { nestedMap: graph },
    { postgresUri: postgres.url, redisUri: redis.url },
  );
  const runtime = createProtocolRuntime(assembly.deps, { scheduler: { enabled: false } });
  try {
    await runtime.service.assistants.registerGraphAssistants();
    const client = runtime.createNativeClient({
      sourceId: "nested-map",
      allowedAssistants: ["nestedMap"],
    });
    runtime.worker.start();
    const first = await client.start({ assistant_id: "nestedMap", input: {} });
    await expect
      .poll(async () => (await client.getRun(first.runId)).status, { timeout: 10_000 })
      .toBe("interrupted");
    const checkpoint = (await client.getState(first.threadId)).checkpoint;
    const history = [];
    for await (const tuple of assembly.deps.checkpointer.list({
      configurable: { thread_id: first.threadId },
    }))
      history.push(tuple);
    const namespace = history.find((tuple) => tuple.config.configurable?.["checkpoint_ns"])!.config
      .configurable!["checkpoint_ns"] as string;
    const current = (await assembly.deps.checkpointer.getTuple({
      configurable: { thread_id: first.threadId, checkpoint_ns: namespace },
    }))!;
    const earlier = history.find(
      (tuple) =>
        tuple.config.configurable?.["checkpoint_ns"] === namespace &&
        tuple.checkpoint.id !== current.checkpoint.id,
    )!;
    await expect(
      client.resume({
        assistant_id: "nestedMap",
        thread_id: first.threadId,
        expected: {
          runId: first.runId,
          checkpoint: { ...checkpoint, checkpoint_map: { [namespace]: earlier.checkpoint.id } },
        },
        resume: "approve",
      }),
    ).rejects.toMatchObject({ code: "stale_resume" });
    const answer = await client.resume({
      assistant_id: "nestedMap",
      thread_id: first.threadId,
      expected: { runId: first.runId, checkpoint },
      resume: "approve",
    });
    await expect
      .poll(async () => (await client.getRun(answer.runId)).status, { timeout: 10_000 })
      .toBe("success");
    expect(preparations).toBe(1);
  } finally {
    await runtime.worker.stop();
    await assembly.dispose();
  }
}, 30_000);

it("stops HTTP-origin execution after Redis accepts a cancellation publish without delivering it", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let stopped = false;
  const state = Annotation.Root({ answer: Annotation<string> });
  const graph = new StateGraph(state)
    .addNode("wait", async (_state, config) => {
      entered();
      await new Promise<void>((_resolve, reject) => {
        config.signal!.addEventListener(
          "abort",
          () => {
            stopped = true;
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      });
      return { answer: "unexpected" };
    })
    .addEdge("__start__", "wait")
    .addEdge("wait", "__end__")
    .compile();
  const assemblies = await Promise.all(
    [0, 1].map(() =>
      embedPostgresGraphs({ lostAbort: graph }, { postgresUri: postgres.url, redisUri: redis.url }),
    ),
  );
  // A disconnected subscriber misses a successful Redis PUBLISH. Retrying publication cannot prove
  // delivery; durable status observation on the execution owner is necessary.
  const ownerChannel = assemblies[0]!.deps.abortChannel!;
  assemblies[0]!.deps.abortChannel = {
    requestAbort: (request) => ownerChannel.requestAbort(request),
    subscribe: () => ({ close: async () => undefined }),
  };
  const owner = createProtocolRuntime(assemblies[0]!.deps, { scheduler: { enabled: false } });
  const receiver = createProtocolRuntime(assemblies[1]!.deps, { scheduler: { enabled: false } });
  try {
    await owner.service.assistants.registerGraphAssistants();
    const thread = await owner.service.threads.create();
    const run = await owner.service.runs.createBackground(thread.thread_id, {
      assistant_id: "lostAbort",
      input: {},
    });
    owner.worker.start();
    await started;
    const client = receiver.createNativeClient({
      sourceId: "cross-instance",
      allowedAssistants: ["lostAbort"],
    });
    const cancelled = await client.cancel(run.run_id, {
      idempotencyKey: "lost-publish",
      wait: true,
    });
    expect(cancelled).toMatchObject({ status: "cancelled", stopped: true });
    expect(stopped).toBe(true);
    expect(await client.getReceipt("lost-publish")).toEqual(cancelled.receipt);
  } finally {
    await Promise.all([owner.worker.stop(), receiver.worker.stop()]);
    await Promise.all(assemblies.map((assembly) => assembly.dispose()));
  }
}, 30_000);

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
