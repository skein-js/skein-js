import { createHash } from "node:crypto";

import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  type NativeCallOptions,
  type NativeClient,
  type NativeResumeInput,
  type NativeStartInput,
  type WebhookDispatcher,
} from "@skein-js/agent-protocol";
import {
  isSkeinHttpError,
  serializeWireJson,
  SkeinHttpError,
  type RunResult,
} from "@skein-js/core";
import { Worker, UnrecoverableError, type ConnectionOptions, type Job, type Queue } from "bullmq";
import { z } from "zod";

import type { BullMqChunk, BullMqCommand, BullMqOutcome } from "./messages.js";

export interface BullMqTransportOptions {
  commandQueue: string;
  /** Borrowed queue. The adapter never closes it or its connection. */
  outcomeQueue: Queue;
  /** A borrowed ioredis 5 connection or BullMQ connection options. */
  connection: ConnectionOptions;
  prefix?: string;
  concurrency?: number;
  maxMessageBytes?: number;
  /** Verify broker credentials/claims here. No authority is accepted from the message itself. */
  authenticate(
    job: Job,
  ): Promise<Omit<NativeCallOptions, "idempotencyKey" | "idempotencyInput" | "correlationId">>;
  /** Host-controlled mapping; the original validated command remains its idempotency identity. */
  route?(command: BullMqCommand): BullMqCommand | Promise<BullMqCommand>;
  projectResult?(result: RunResult, runId: string): unknown | Promise<unknown>;
  logger?: { warn(message: string, error?: unknown): void };
}

export interface BullMqTransport {
  /** Bind this stable address to the native source's outcomeTarget. */
  readonly outcomeTarget: string;
  wrapDispatcher(inner: WebhookDispatcher): WebhookDispatcher;
  start(client: NativeClient): Promise<void>;
  stop(): Promise<void>;
}

const key = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x20-\x7e]+$/);
const chunkFields = {
  offset: z.number().int().nonnegative().optional(),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
};
const base = {
  version: z.literal(1),
  commandId: key,
  correlationId: z.string().max(255).optional(),
};
const commandSchema = z.discriminatedUnion("operation", [
  z.object({ ...base, operation: z.literal("start"), input: z.record(z.unknown()) }).strict(),
  z.object({ ...base, operation: z.literal("resume"), input: z.record(z.unknown()) }).strict(),
  z
    .object({
      ...base,
      operation: z.literal("cancel"),
      runId: z.string().min(1),
      action: z.enum(["interrupt", "rollback"]).optional(),
      wait: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ ...base, operation: z.literal("run.get"), runId: z.string().min(1), ...chunkFields })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal("state.get"),
      threadId: z.string().min(1),
      ...chunkFields,
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal("result.get"),
      runId: z.string().min(1),
      ...chunkFields,
    })
    .strict(),
  z.object({ ...base, operation: z.literal("receipt.get"), idempotencyKey: key }).strict(),
]);

function parseCommand(input: unknown, cap: number): BullMqCommand {
  if (Buffer.byteLength(serializeWireJson(input)) > cap)
    throw SkeinHttpError.unprocessable("Broker command exceeds the message limit.", {
      code: "message_too_large",
    });
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success)
    throw SkeinHttpError.badRequest("Invalid BullMQ command.", {
      code: "invalid_bullmq_command",
      details: parsed.error.issues,
    });
  return parsed.data as BullMqCommand;
}

function chunk(
  value: unknown,
  request: { offset?: number; digest?: string },
  cap: number,
): BullMqChunk {
  const bytes = Buffer.from(serializeWireJson(value));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (request.digest && request.digest !== digest)
    throw SkeinHttpError.conflict("The requested value changed; restart retrieval.", {
      code: "result_digest_mismatch",
    });
  const offset = request.offset ?? 0;
  if (offset > 0 && !request.digest)
    throw SkeinHttpError.badRequest("Continuation requires its digest.", {
      code: "result_digest_required",
    });
  if (offset > bytes.length)
    throw SkeinHttpError.badRequest("Chunk offset is outside the result.", {
      code: "invalid_chunk_offset",
    });
  // Reserve framing space and account for base64 expansion. The final bound is checked below.
  const end = Math.min(bytes.length, offset + Math.floor(((cap - 512) * 3) / 4));
  const result: BullMqChunk = {
    encoding: "base64",
    digest,
    offset,
    nextOffset: end < bytes.length ? end : null,
    totalBytes: bytes.length,
    content: bytes.subarray(offset, end).toString("base64"),
  };
  if (Buffer.byteLength(serializeWireJson(result)) > cap)
    throw new Error("BullMQ chunk framing exceeded its bound.");
  return result;
}

const transientCodes = new Set([
  "execution_lease_lost",
  "thread_busy",
  "thread_status_mismatch",
  "idempotency_key_in_flight",
  "run_result_pending",
]);
function classify(error: unknown): never {
  if (
    isSkeinHttpError(error) &&
    !transientCodes.has(error.code ?? "") &&
    (error.status < 500 || error.status === 501)
  )
    throw new UnrecoverableError(
      JSON.stringify({
        code: error.code ?? "command_rejected",
        message: error.message,
        status: error.status,
      }),
    );
  throw error;
}

/** Optional access transport. Skein's own execution and delivery queues remain in charge. */
export function createBullMqTransport(options: BullMqTransportOptions): BullMqTransport {
  const cap = options.maxMessageBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  if (!Number.isSafeInteger(cap) || cap < 1024 || cap > DEFAULT_MAX_PAYLOAD_BYTES)
    throw new Error("maxMessageBytes must be between 1024 and the existing payload limit.");
  if (!options.commandQueue) throw new Error("commandQueue is required.");
  const logger = options.logger ?? console;
  const outcomeTarget = `skein-bullmq://outcomes/${encodeURIComponent(options.outcomeQueue.opts.prefix ?? "bull")}/${encodeURIComponent(options.outcomeQueue.name)}`;
  let worker: Worker | undefined;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let running: Promise<void> | undefined;
  const processCommand = async (client: NativeClient, job: Job): Promise<unknown> => {
    try {
      const original = parseCommand(job.data, cap);
      const { correlationId: _diagnostic, ...meaning } = JSON.parse(
        serializeWireJson(original),
      ) as BullMqCommand;
      const authenticated = await options.authenticate(job);
      const command = options.route
        ? parseCommand(await options.route(structuredClone(original)), cap)
        : original;
      const call: NativeCallOptions = {
        ...authenticated,
        idempotencyKey: original.commandId,
        idempotencyInput: meaning,
        ...(original.correlationId ? { correlationId: original.correlationId } : {}),
      };
      switch (command.operation) {
        case "start":
          return await client.start(command.input as NativeStartInput, call);
        case "resume":
          return await client.resume(command.input as NativeResumeInput, call);
        case "cancel":
          return await client.cancel(command.runId, {
            ...call,
            action: command.action,
            wait: command.wait,
          });
        case "run.get": {
          const run = await client.getRun(command.runId, call);
          return chunk(run, command, cap);
        }
        case "receipt.get":
          return await client.getReceipt(command.idempotencyKey, call);
        case "state.get":
          return chunk(await client.getState(command.threadId, call), command, cap);
        case "result.get": {
          const result = await client.getResult(command.runId, call);
          return chunk(
            options.projectResult ? await options.projectResult(result, command.runId) : result,
            command,
            cap,
          );
        }
      }
    } catch (error) {
      classify(error);
    }
  };
  return {
    outcomeTarget,
    wrapDispatcher: (inner) => async (url, payload, attempt) => {
      if (url !== outcomeTarget) return inner(url, payload, attempt);
      if (!attempt?.deliveryId)
        throw new Error("BullMQ outcomes require an outbox delivery identity.");
      const body = payload as Record<string, unknown>;
      if (
        typeof body["run_id"] !== "string" ||
        typeof body["thread_id"] !== "string" ||
        typeof body["command_id"] !== "string"
      )
        throw new Error("Invalid native outcome.");
      const event: BullMqOutcome = {
        version: 1,
        operation: "run.settled",
        eventId: attempt.deliveryId,
        commandId: body["command_id"],
        ...(typeof body["correlation_id"] === "string"
          ? { correlationId: body["correlation_id"] }
          : {}),
        runId: body["run_id"],
        threadId: body["thread_id"],
        status: body["status"] as BullMqOutcome["status"],
        resultRef: { runId: body["run_id"] },
        truncated: body["payload_truncated"] === true,
        outcome: options.projectResult
          ? body["payload_truncated"] === true || body["result_unavailable"] === true
            ? undefined
            : await options.projectResult(
                {
                  values: body["values"] as RunResult["values"],
                  ...(body["interrupts"]
                    ? { interrupts: body["interrupts"] as RunResult["interrupts"] }
                    : {}),
                  ...(body["reply"] !== undefined ? { reply: body["reply"] } : {}),
                },
                body["run_id"],
              )
          : payload,
      };
      if (Buffer.byteLength(serializeWireJson(event)) > cap) {
        delete event.outcome;
        event.truncated = true;
      }
      if (Buffer.byteLength(serializeWireJson(event)) > cap)
        throw new Error("BullMQ outcome identity exceeds the message bound.");
      await options.outcomeQueue.add("skein.run.settled.v1", event, { jobId: event.eventId });
    },
    start: async (client) => {
      if (stopping) await stopping;
      if (starting) return starting;
      if (worker) return;
      starting = (async () => {
        const owned = new Worker(options.commandQueue, (job) => processCommand(client, job), {
          connection: options.connection,
          ...(options.prefix ? { prefix: options.prefix } : {}),
          concurrency: options.concurrency ?? 1,
          autorun: false,
        });
        worker = owned;
        owned.on("error", (error) => logger.warn("BullMQ command worker error", error));
        try {
          await owned.waitUntilReady();
          running = owned
            .run()
            .catch((error: unknown) => logger.warn("BullMQ command worker stopped", error));
        } catch (error) {
          worker = undefined;
          await owned.close();
          throw error;
        }
      })();
      try {
        await starting;
      } finally {
        starting = undefined;
      }
    },
    stop: async () => {
      if (stopping) return stopping;
      stopping = (async () => {
        await starting;
        const owned = worker;
        worker = undefined;
        await owned?.close();
        await running;
        running = undefined;
      })();
      try {
        await stopping;
      } finally {
        stopping = undefined;
      }
    },
  };
}
