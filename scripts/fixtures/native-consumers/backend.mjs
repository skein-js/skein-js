import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { Queue, QueueEvents } from "bullmq";
import { createBullMqTransport } from "@skein-js/bullmq";
import { embedPostgresGraphs } from "@skein-js/runtime";
import { createExpressServer } from "@skein-js/express";
import { openSqliteStorage } from "@skein-js/storage-sqlite";
import { approvalGraph } from "./approval.mjs";

const identity = {
  user: {
    identity: "approval-worker",
    display_name: "approval-worker",
    is_authenticated: true,
    permissions: [],
  },
  scopes: [],
};
const auth = {
  enabled: true,
  studioAuthDisabled: false,
  async authenticate(request) {
    assert.equal(request.headers.get("authorization"), "Bearer host-token");
    return identity;
  },
  async authorize({ context, value }) {
    assert.ok(context?.user.is_authenticated);
    return { value, filters: { owner: context.user.identity } };
  },
  matchesFilters(metadata, filters) {
    return metadata?.owner === filters.owner;
  },
};
const redis = new URL(process.env.REDIS_URI);
const connection = { host: redis.hostname, port: Number(redis.port), maxRetriesPerRequest: null };
const commands = new Queue(`commands-${randomUUID()}`, { connection });
const outcomes = new Queue(`outcomes-${randomUUID()}`, { connection });
const events = new QueueEvents(commands.name, { connection, lastEventId: "0-0" });
const transport = createBullMqTransport({
  commandQueue: commands.name,
  outcomeQueue: outcomes,
  connection,
  maxMessageBytes: 2048,
  // This queue is restricted to one trusted producer by the deployment's Redis ACL. Authority is host-bound.
  authenticate: async () => ({ authContext: identity }),
});
let failAcknowledgement = true;
const dispatch = transport.wrapDispatcher(async () => {
  throw new Error("unexpected destination");
});
const embedded = await embedPostgresGraphs(
  { approval: approvalGraph() },
  {
    postgresUri: process.env.POSTGRES_URI,
    redisUri: process.env.REDIS_URI,
    overrides: {
      auth,
      webhookDispatcher: async (...args) => {
        await dispatch(...args);
        if (failAcknowledgement) throw new Error("publication succeeded; acknowledgement lost");
      },
    },
  },
);
const server = await createExpressServer({ deps: embedded.deps, scheduler: { enabled: false } });
const listener = await server.listen(0, "127.0.0.1");
const url = `http://127.0.0.1:${listener.address().port}`;
const client = server.runtime.createNativeClient({
  sourceId: "approval-queue",
  allowedAssistants: ["approval"],
  outcomeTarget: transport.outcomeTarget,
});
const call = { authContext: identity };
const poll = async (read, predicate) => {
  for (let index = 0; index < 500; index++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out");
};
const request = async (path, body) => {
  const response = await fetch(url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer host-token", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
};
const send = async (command) => {
  const job = await commands.add(
    "skein.command.v1",
    { version: 1, ...command },
    { attempts: 3, backoff: { type: "fixed", delay: 50 } },
  );
  return { job, receipt: await job.waitUntilFinished(events, 15000) };
};
try {
  await transport.start(client);
  const thread = await request("/threads", {});
  const first = await request(`/threads/${thread.thread_id}/runs`, {
    assistant_id: "approval",
    input: {},
  });
  await poll(
    () => client.getRun(first.run_id, call),
    (run) => run.status === "interrupted",
  );
  const state = await client.getState(thread.thread_id, call);
  const command = {
    commandId: "human-answer",
    operation: "resume",
    input: {
      assistant_id: "approval",
      thread_id: thread.thread_id,
      expected: { runId: first.run_id, checkpoint: state.checkpoint },
      resume: "approve",
    },
  };
  const accepted = await send(command);
  await accepted.job.remove();
  assert.deepEqual((await send(command)).receipt, accepted.receipt);
  await poll(
    () => client.getRun(accepted.receipt.runId, call),
    (run) => run.status === "success",
  );
  const pieces = [];
  let offset = 0,
    digest;
  do {
    const { receipt: chunk } = await send({
      commandId: randomUUID(),
      operation: "result.get",
      runId: accepted.receipt.runId,
      offset,
      digest,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(chunk)) <= 2048);
    pieces.push(Buffer.from(chunk.content, "base64"));
    offset = chunk.nextOffset;
    digest = chunk.digest;
  } while (offset !== null);
  const bytes = Buffer.concat(pieces);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
  assert.equal(JSON.parse(bytes).values.answer, "approved ".repeat(2000));
  await assert.rejects(send({ ...command, commandId: "stale-answer" }), /stale_resume/);
  const pending = await send({
    commandId: "pending",
    operation: "start",
    input: { assistant_id: "approval", input: {}, after_seconds: 60 },
  });
  const cancelled = await send({
    commandId: "cancel-pending",
    operation: "cancel",
    runId: pending.receipt.runId,
    wait: true,
  });
  assert.equal(cancelled.receipt.status, "cancelled");
  assert.equal(cancelled.receipt.stopped, true);
  assert.deepEqual(
    (await send({ commandId: "lookup", operation: "receipt.get", idempotencyKey: "pending" }))
      .receipt,
    pending.receipt,
  );

  const delivery = await poll(
    () => embedded.deps.store.deliveries.listByRun(accepted.receipt.runId),
    (rows) => rows.length > 0,
  );
  const eventId = delivery[0].delivery_id;
  const published = await poll(
    () => outcomes.getJob(eventId),
    (job) => !!job,
  );
  const original = published.data;
  let receiver = await openSqliteStorage({ filename: resolve("receiver.sqlite") });
  receiver.database.exec("CREATE TABLE IF NOT EXISTS received_events(event_id TEXT PRIMARY KEY)");
  assert.equal(
    receiver.database
      .prepare("INSERT OR IGNORE INTO received_events VALUES (?)")
      .run(original.eventId).changes,
    1,
  );
  await receiver.dispose();
  await published.remove();
  failAcknowledgement = false;
  await embedded.deps.store.deliveries.retryNow(eventId, new Date().toISOString());
  await server.runtime.deliveryWorker.tickOnce();
  const repeated = await poll(
    () => outcomes.getJob(eventId),
    (job) => !!job,
  );
  receiver = await openSqliteStorage({ filename: resolve("receiver.sqlite") });
  assert.equal(repeated.data.eventId, original.eventId);
  assert.equal(
    receiver.database
      .prepare("INSERT OR IGNORE INTO received_events VALUES (?)")
      .run(repeated.data.eventId).changes,
    0,
  );
  await receiver.dispose();
  console.log(
    "PACKED_NATIVE_BACKEND_OK: HTTP + BullMQ, strict resume, receipts, cancellation, chunks, durable receiver dedup",
  );
} finally {
  await transport.stop();
  await server.close();
  await embedded.dispose();
  await Promise.all([commands.close(), outcomes.close(), events.close()]);
}
