import { randomUUID } from "node:crypto";

import {
  createProtocolRuntime,
  type AgentGraph,
  type ThreadCheckpointer,
  type NativeClient,
} from "@skein-js/agent-protocol";
import { SkeinHttpError, type AdmissionReceipt } from "@skein-js/core";
import { MemorySkeinStore, MemoryRunQueue, MemoryRunEventBus } from "@skein-js/storage-memory";
import { startRedis, type StartedResource } from "@skein-js/test-support";
import { Queue, QueueEvents } from "bullmq";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createBullMqTransport } from "./bullmq-transport.js";
import type { BullMqChunk, BullMqCommand, BullMqOutcome } from "./messages.js";

let redis: StartedResource;
beforeAll(async () => {
  redis = await startRedis();
});
afterAll(async () => {
  await redis?.stop();
});

async function fixture(cap = 2048, eventsAutorun = true) {
  const url = new URL(redis.url);
  const connection = { host: url.hostname, port: Number(url.port), maxRetriesPerRequest: null };
  const name = `native-${randomUUID()}`;
  const commands = new Queue(`${name}-commands`, { connection });
  const outcomes = new Queue(`${name}-outcomes`, { connection });
  const events = new QueueEvents(commands.name, {
    connection,
    autorun: eventsAutorun,
    lastEventId: "0-0",
  });
  const store = new MemorySkeinStore();
  const states = new Map<string, unknown>();
  const graph: AgentGraph = {
    async *stream(input, options) {
      const threadId = (options as { configurable: { thread_id: string } }).configurable.thread_id;
      states.set(threadId, input);
      yield ["values", input];
    },
    async getState(config) {
      return {
        values: states.get(String(config.configurable?.["thread_id"])) ?? {},
        next: [],
        tasks: [],
      };
    },
  };
  const checkpointer: ThreadCheckpointer = {
    async getTuple() {
      return undefined;
    },
    async *list() {
      /* empty */
    },
    async put(config) {
      return config;
    },
    async putWrites() {
      /* none */
    },
    async deleteThread() {
      /* none */
    },
  };
  const transport = createBullMqTransport({
    commandQueue: commands.name,
    outcomeQueue: outcomes,
    connection,
    maxMessageBytes: cap,
    authenticate: async () => ({}),
  });
  const runtime = createProtocolRuntime(
    {
      store,
      queue: new MemoryRunQueue(),
      bus: new MemoryRunEventBus(),
      checkpointer,
      graphs: { ids: ["agent"], load: async () => graph, schemas: async () => ({}) },
      webhookDispatcher: transport.wrapDispatcher(async () => {
        throw new Error("unexpected address");
      }),
    },
    { scheduler: { enabled: false } },
  );
  await runtime.service.assistants.registerGraphAssistants();
  const client = runtime.createNativeClient({
    sourceId: name,
    allowedAssistants: ["agent"],
    outcomeTarget: transport.outcomeTarget,
  });
  const send = async (command: BullMqCommand) => {
    const job = await commands.add("skein.command.v1", command, {
      attempts: 3,
      backoff: { type: "fixed", delay: 50 },
    });
    return job.waitUntilFinished(events, 10_000);
  };
  return {
    store,
    runtime,
    client,
    transport,
    commands,
    outcomes,
    events,
    send,
    async close() {
      await transport.stop();
      await runtime.worker.stop();
      await Promise.all([commands.close(), outcomes.close(), events.close()]);
    },
  };
}

describe("BullMQ native access over Redis", () => {
  it("retries a state read whose target changed during authorization", async () => {
    const f = await fixture();
    try {
      const receipt = await f.client.start({ assistant_id: "agent", input: {} });
      const read = vi
        .spyOn(f.client, "getState")
        .mockRejectedValueOnce(
          SkeinHttpError.conflict("Target changed.", { code: "native_state_changed" }),
        );
      await f.transport.start(f.client);
      const result = (await f.send({
        version: 1,
        commandId: "read-state",
        operation: "state.get",
        threadId: receipt.threadId,
      })) as BullMqChunk;
      expect(result.encoding).toBe("base64");
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  });
  it("keeps original command meaning when a host router mutates its input or changes its route", async () => {
    const f = await fixture();
    let selected = "agent";
    const access = createBullMqTransport({
      commandQueue: f.commands.name,
      outcomeQueue: f.outcomes,
      connection: f.commands.opts.connection,
      authenticate: async () => ({}),
      route: (command) => {
        command.commandId = `derived-${selected}`;
        command.correlationId = "derived-trace";
        if (command.operation === "start") command.input.assistant_id = selected;
        return command;
      },
    });
    try {
      await access.start(f.client);
      const command: BullMqCommand = {
        version: 1,
        commandId: "routed",
        operation: "start",
        input: { assistant_id: "requested", input: {} },
      };
      const first = (await f.send(command)) as AdmissionReceipt;
      expect(first.idempotencyKey).toBe("routed");
      selected = "outside";
      expect(await f.send(command)).toEqual(first);
      expect((await f.client.getRun(first.runId)).assistant_id).toBe("agent");
    } finally {
      await access.stop();
      await f.close();
    }
  });
  it("permanently rejects asynchronous native authorization failures without spending all retries", async () => {
    const f = await fixture();
    try {
      await f.transport.start(f.client);
      const job = await f.commands.add(
        "skein.command.v1",
        {
          version: 1,
          commandId: "forbidden",
          operation: "start",
          input: { assistant_id: "outside" },
        },
        { attempts: 4 },
      );
      await expect(job.waitUntilFinished(f.events, 10_000)).rejects.toThrow(
        "assistant_not_allowed",
      );
      expect((await f.commands.getJob(job.id!))!.attemptsMade).toBe(1);
    } finally {
      await f.close();
    }
  });

  it("applies host output projection without passing truncated output off as a whole result", async () => {
    const f = await fixture();
    const project = vi.fn((result: { values: Record<string, unknown> }) => ({
      allowed: result.values["answer"],
    }));
    const access = createBullMqTransport({
      commandQueue: f.commands.name,
      outcomeQueue: f.outcomes,
      connection: f.commands.opts.connection,
      authenticate: async () => ({}),
      projectResult: project,
    });
    try {
      const dispatch = access.wrapDispatcher(async () => {
        throw new Error("wrong destination");
      });
      const payload = {
        run_id: randomUUID(),
        thread_id: randomUUID(),
        command_id: "project",
        status: "success",
        values: { answer: "public", secret: "private" },
      };
      const eventId = randomUUID();
      await dispatch(access.outcomeTarget, payload, {
        deliveryId: eventId,
        attempt: 1,
        headers: {},
        body: JSON.stringify(payload),
      });
      expect((await f.outcomes.getJob(eventId))!.data.outcome).toEqual({ allowed: "public" });
      const truncatedId = randomUUID();
      await dispatch(
        access.outcomeTarget,
        { ...payload, payload_truncated: true },
        { deliveryId: truncatedId, attempt: 1, headers: {}, body: "" },
      );
      expect(project).toHaveBeenCalledTimes(1);
      expect((await f.outcomes.getJob(truncatedId))!.data).toMatchObject({
        truncated: true,
        resultRef: { runId: payload.run_id },
      });
      expect((await f.outcomes.getJob(truncatedId))!.data.outcome).toBeUndefined();
    } finally {
      await f.close();
    }
  });
  it("observes admission completed before the command event loop starts", async () => {
    const f = await fixture(2048, false);
    const borrowed = new Redis(redis.url, { maxRetriesPerRequest: null });
    const access = createBullMqTransport({
      commandQueue: f.commands.name,
      outcomeQueue: f.outcomes,
      connection: borrowed,
      authenticate: async () => ({}),
    });
    let eventsRunning: Promise<void> | undefined;
    try {
      // A ready Redis connection does not mean QueueEvents has issued its first stream read.
      await f.events.waitUntilReady();
      const job = await f.commands.add("skein.command.v1", {
        version: 1,
        commandId: "waiter-startup",
        operation: "start",
        input: { assistant_id: "agent", input: {} },
      });
      let notifyPendingCheck!: () => void;
      const pendingChecked = new Promise<void>((resolve) => {
        notifyPendingCheck = resolve;
      });
      const scripts = Reflect.get(job, "scripts") as {
        isFinished(jobId: string, returnValue: boolean): Promise<[number, string]>;
      };
      const isFinished = scripts.isFinished.bind(scripts);
      vi.spyOn(scripts, "isFinished").mockImplementation(async (...args) => {
        const result = await isFinished(...args);
        expect(result[0]).toBe(0);
        notifyPendingCheck();
        return result;
      });
      const waiting = job.waitUntilFinished(f.events, 10_000);
      await pendingChecked;
      await access.start(f.client);
      await expect.poll(() => job.getState()).toBe("completed");
      // The initial status poll saw pending, but completion precedes the first event read.
      eventsRunning = f.events.run();
      const receipt = await waiting;
      expect(receipt).toEqual(await f.client.getReceipt("waiter-startup"));
      expect((await f.client.getRun(receipt.runId)).status).toBe("pending");
      await access.stop();
      expect(await borrowed.ping()).toBe("PONG");
    } finally {
      await access.stop();
      await borrowed.quit();
      await f.close();
      await eventsRunning;
    }
  });
  it("preserves a borrowed ioredis 5 connection after stopping its worker", async () => {
    const f = await fixture();
    const borrowed = new Redis(redis.url, { maxRetriesPerRequest: null });
    const access = createBullMqTransport({
      commandQueue: f.commands.name,
      outcomeQueue: f.outcomes,
      connection: borrowed,
      authenticate: async () => ({}),
    });
    try {
      await access.start(f.client);
      expect(
        await f.send({
          version: 1,
          commandId: "borrowed",
          operation: "start",
          input: { assistant_id: "agent", input: {} },
        }),
      ).toHaveProperty("runId");
      await access.stop();
      expect(await borrowed.ping()).toBe("PONG");
    } finally {
      await access.stop();
      await borrowed.quit();
      await f.close();
    }
  });
  it("consumes only after explicit start, acknowledges acceptance, and deduplicates after job removal", async () => {
    const f = await fixture();
    try {
      const command: BullMqCommand = {
        version: 1,
        commandId: "approval-1",
        correlationId: "first-trace",
        operation: "start",
        input: { assistant_id: "agent", input: { answer: "approved" } },
      };
      const pending = await f.commands.add("skein.command.v1", command);
      expect(await pending.getState()).toBe("waiting");
      await f.transport.start(f.client);
      const first = (await pending.waitUntilFinished(f.events, 10_000)) as AdmissionReceipt;
      expect((await f.client.getRun(first.runId)).status).toBe("pending");
      await pending.remove();
      expect(await f.send({ ...command, correlationId: "retry-trace" })).toEqual(first);
      expect(await f.store.runs.listByThread(first.threadId)).toHaveLength(1);
      f.runtime.worker.start();
      await expect.poll(async () => (await f.client.getRun(first.runId)).status).toBe("success");
      expect((await f.client.getResult(first.runId)).values).toEqual({ answer: "approved" });
      await f.runtime.deliveryWorker.tickOnce();
      const delivered = await f.outcomes.getJobs(["waiting"]);
      expect(delivered).toHaveLength(1);
      const event = delivered[0]!.data as BullMqOutcome;
      expect(event).toMatchObject({
        commandId: "approval-1",
        correlationId: "first-trace",
        runId: first.runId,
        status: "success",
      });
      const stable = (await f.store.deliveries!.listByRun(first.runId))[0]!.delivery_id;
      expect(event.eventId).toBe(stable);
      await f.transport.stop();
      expect((await f.outcomes.add("still-open", {})).id).toBeDefined();
    } finally {
      await f.close();
    }
  });

  it("retrieves a large retained result in bounded authorized digest-checked chunks", async () => {
    const f = await fixture(1024);
    try {
      const receipt = await f.client.start({
        assistant_id: "agent",
        input: { answer: "x".repeat(9000) },
        metadata: { memo: "m".repeat(9000) },
      });
      f.runtime.worker.start();
      await expect.poll(async () => (await f.client.getRun(receipt.runId)).status).toBe("success");
      let authorizations = 0;
      const bound: NativeClient = {
        ...f.client,
        getResult: async (...args) => {
          authorizations++;
          return f.client.getResult(...args);
        },
      };
      await f.transport.start(bound);
      const runPart = (await f.send({
        version: 1,
        commandId: "run-read",
        operation: "run.get",
        runId: receipt.runId,
      })) as BullMqChunk;
      expect(runPart.nextOffset).not.toBeNull();
      expect(Buffer.byteLength(JSON.stringify(runPart))).toBeLessThanOrEqual(1024);
      const chunks: Buffer[] = [];
      let offset = 0;
      let digest: string | undefined;
      do {
        const part = (await f.send({
          version: 1,
          commandId: randomUUID(),
          operation: "result.get",
          runId: receipt.runId,
          offset,
          digest,
        })) as BullMqChunk;
        expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThanOrEqual(1024);
        chunks.push(Buffer.from(part.content, "base64"));
        digest = part.digest;
        offset = part.nextOffset ?? -1;
      } while (offset !== -1);
      expect(JSON.parse(Buffer.concat(chunks).toString()).values.answer).toHaveLength(9000);
      expect(authorizations).toBe(chunks.length);
      await expect(
        f.send({
          version: 1,
          commandId: "bad-digest",
          operation: "result.get",
          runId: receipt.runId,
          offset: 1,
          digest: "a".repeat(64),
        }),
      ).rejects.toThrow("result_digest_mismatch");
    } finally {
      await f.close();
    }
  });

  it("retains event identity after publication-before-ack and removal from the broker", async () => {
    const f = await fixture();
    try {
      const deliveryId = randomUUID();
      const payload = {
        run_id: randomUUID(),
        thread_id: randomUUID(),
        command_id: "original",
        status: "success",
        values: { answer: "x".repeat(8000) },
      };
      const dispatch = f.transport.wrapDispatcher(async () => {
        throw new Error("wrong destination");
      });
      const attempt = { deliveryId, attempt: 1, headers: {}, body: JSON.stringify(payload) };
      await dispatch(f.transport.outcomeTarget, payload, attempt);
      const first = await f.outcomes.getJob(deliveryId);
      expect(first!.data).toMatchObject({
        eventId: deliveryId,
        truncated: true,
        resultRef: { runId: payload.run_id },
      });
      await first!.remove();
      // Models a receiver that persisted eventId before the producer lost its outbox ack.
      const receiver = new Set<string>([deliveryId]);
      await dispatch(f.transport.outcomeTarget, payload, { ...attempt, attempt: 2 });
      const retried = await f.outcomes.getJob(deliveryId);
      expect(receiver.has((retried!.data as BullMqOutcome).eventId)).toBe(true);
      const rebuilt = createBullMqTransport({
        commandQueue: f.commands.name,
        outcomeQueue: f.outcomes,
        connection: f.commands.opts.connection,
        authenticate: async () => ({}),
      });
      expect(rebuilt.outcomeTarget).toBe(f.transport.outcomeTarget);
    } finally {
      await f.close();
    }
  });
});
