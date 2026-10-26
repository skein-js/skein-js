import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createBullMqTransport } from "@skein-js/bullmq";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";

const require = createRequire(import.meta.url);
const adapterRequire = createRequire(require.resolve("@skein-js/bullmq"));
const versions = {
  host: require("bullmq/package.json").version,
  adapter: adapterRequire("bullmq/package.json").version,
};
assert.equal(versions.host.split(".")[0], "6");
console.log("PNPM_BULLMQ_UPGRADE", JSON.stringify(versions));

const name = `upgrade-${randomUUID()}`;
const connection = { url: process.env.REDIS_URI };
const commands = new Queue(`${name}-commands`, { connection });
const outcomes = new Queue(`${name}-outcomes`, { connection });
const events = new QueueEvents(commands.name, { connection, lastEventId: "0-0" });
const borrowed = new Redis(connection.url, { maxRetriesPerRequest: null });
const access = createBullMqTransport({
  commandQueue: commands.name,
  outcomeQueue: outcomes,
  connection: borrowed,
  authenticate: async () => ({}),
});
const receipt = { runId: randomUUID(), threadId: randomUUID(), idempotencyKey: "upgrade" };
try {
  await events.waitUntilReady();
  // This fixture isolates cross-version broker behavior; graph execution is covered by backend.mjs.
  await access.start({ start: async () => receipt });
  const job = await commands.add("skein.command.v1", {
    version: 1,
    commandId: "upgrade",
    operation: "start",
    input: { assistant_id: "agent", input: {} },
  });
  assert.deepEqual(await job.waitUntilFinished(events, 10_000), receipt);
  await access.stop();
  assert.equal(await borrowed.ping(), "PONG");
  const deliveryId = randomUUID();
  const payload = {
    run_id: receipt.runId,
    thread_id: receipt.threadId,
    command_id: "upgrade",
    status: "success",
  };
  const dispatch = access.wrapDispatcher(async () => {
    throw new Error("Unexpected outcome target");
  });
  await dispatch(access.outcomeTarget, payload, { deliveryId });
  assert.equal((await outcomes.getJob(deliveryId)).data.eventId, deliveryId);
} finally {
  await access.stop();
  await Promise.all([commands.close(), outcomes.close(), events.close()]);
  await borrowed.quit();
}
console.log("PNPM_BULLMQ_UPGRADE_OK");
