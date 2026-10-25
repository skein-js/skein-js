import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { BullMqChunk, BullMqCommand, BullMqOutcome } from "@skein-js/bullmq";
import type { AdmissionReceipt, ThreadState } from "@skein-js/core";
import { Queue, QueueEvents, Worker } from "bullmq";

import {
  commandId,
  commandQueueName,
  connectRedis,
  outcomeQueueName,
  receiverPath,
} from "./settings.js";

await mkdir(dirname(receiverPath), { recursive: true });
const inbox = new DatabaseSync(receiverPath);
inbox.exec(
  "CREATE TABLE IF NOT EXISTS outcomes (event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, outcome TEXT NOT NULL)",
);
const insert = inbox.prepare(
  "INSERT INTO outcomes VALUES (?, ?, ?) ON CONFLICT(event_id) DO NOTHING",
);
const connection = connectRedis();
const commands = new Queue(commandQueueName, { connection });
const events = new QueueEvents(commandQueueName, { connection, lastEventId: "0-0" });
const receiver = new Worker<BullMqOutcome>(
  outcomeQueueName,
  async (job) => {
    // This record is durable before BullMQ acknowledgement. Put application database effects in
    // the same transaction; keep a durable inbox even after broker jobs have been removed.
    insert.run(job.data.eventId, job.data.runId, JSON.stringify(job.data));
  },
  { connection },
);
const send = async (command: BullMqCommand) => {
  const job = await commands.add("skein.command.v1", command, {
    attempts: 5,
    backoff: { type: "exponential", delay: 100 },
    removeOnComplete: 100,
    removeOnFail: 100,
  });
  return job.waitUntilFinished(events, 15_000) as Promise<unknown>;
};
const read = async (request: Extract<BullMqCommand, { operation: "state.get" | "result.get" }>) => {
  const bytes: Buffer[] = [];
  let offset = 0;
  let digest: string | undefined;
  for (;;) {
    const part = (await send({ ...request, offset, ...(digest ? { digest } : {}) })) as BullMqChunk;
    if (part.offset !== offset || (digest && digest !== part.digest))
      throw new Error("Unexpected chunk.");
    digest = part.digest;
    bytes.push(Buffer.from(part.content, "base64"));
    if (part.nextOffset === null) {
      const whole = Buffer.concat(bytes);
      if (
        whole.length !== part.totalBytes ||
        createHash("sha256").update(whole).digest("hex") !== digest
      )
        throw new Error("Result digest mismatch.");
      return JSON.parse(whole.toString("utf8")) as unknown;
    }
    offset = part.nextOffset;
  }
};
try {
  const receipt = (await send({
    version: 1,
    commandId,
    operation: "start",
    input: {
      assistant_id: "approval",
      input: { request: "Publish the release notes" },
    },
  })) as AdmissionReceipt;
  // Use the original run's retained checkpoint so re-running this producer sends identical meaning,
  // even if the thread has advanced. A human UI can also use authorized state.get for a fresh turn.
  const first = (await read({
    version: 1,
    commandId: `${commandId}-first-result`,
    operation: "result.get",
    runId: receipt.runId,
  })) as Pick<ThreadState, "checkpoint">;
  const answer = (await send({
    version: 1,
    commandId: `${commandId}-answer`,
    operation: "resume",
    input: {
      assistant_id: "approval",
      thread_id: receipt.threadId,
      expected: { runId: receipt.runId, checkpoint: first.checkpoint },
      resume: "approve",
    },
  })) as AdmissionReceipt;
  const result = await read({
    version: 1,
    commandId: `${commandId}-result`,
    operation: "result.get",
    runId: answer.runId,
  });
  for (
    let attempt = 0;
    !inbox.prepare("SELECT 1 FROM outcomes WHERE run_id = ?").get(answer.runId);
    attempt++
  ) {
    if (attempt > 500)
      throw new Error("Outcome did not arrive; reconcile using the retained result.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  console.log(
    JSON.stringify(
      {
        receipt,
        answer,
        result,
        outcomes: inbox.prepare("SELECT count(*) AS count FROM outcomes").get(),
      },
      null,
      2,
    ),
  );
} finally {
  await receiver.close();
  await events.close();
  await commands.close();
  await connection.quit();
  inbox.close();
}
