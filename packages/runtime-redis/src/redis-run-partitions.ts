import { createHash } from "node:crypto";

import type { QueuedRun } from "@skein-js/core";
import { DelayedError, type Job, type Queue } from "bullmq";
import { Redis } from "ioredis";

import { closeConnection } from "./redis-connection.js";

// These scripts touch only Skein's scheduling hints. BullMQ's job tokens, transitions and stalled
// recovery remain authoritative, and the engine's execution claim still guards every graph write.
const REGISTER = `
if not redis.call('ZSCORE', KEYS[3], ARGV[1]) then
  redis.call('ZADD', KEYS[3], redis.call('INCR', KEYS[2]), ARGV[1])
end
redis.call('ZADD', KEYS[1], 'NX', ARGV[2], KEYS[3])
local head = redis.call('ZRANGE', KEYS[3], 0, 0)[1]
if head == ARGV[1] then redis.call('HDEL', KEYS[4], ARGV[1]) end
return head
`;
const REMOVE = `
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('HDEL', KEYS[4], ARGV[1])
local head = redis.call('ZRANGE', KEYS[3], 0, 0)[1]
if not head then
  redis.call('DEL', KEYS[3], KEYS[4])
  redis.call('ZREM', KEYS[1], KEYS[3])
  if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1], KEYS[2]) end
end
return head
`;
const RECORD_PARKED = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  local previous = redis.call('HGET', KEYS[2], ARGV[1])
  if not previous or tonumber(previous) <= tonumber(ARGV[2]) then
    redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
  end
end
`;
const TAKE_PARKED = `
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
  return redis.call('HDEL', KEYS[1], ARGV[1])
end
return 0
`;

/** Internal partition order survives worker restart without inspecting any BullMQ Redis keys. */
export function createRedisRunPartitions(url: string, queueName: string, queue: Queue<QueuedRun>) {
  const client = new Redis(url, { lazyConnect: true });
  client.on("error", () => undefined); // Individual commands surface failures to their caller.
  const prefix = `skein-dispatch:${queueName}`;
  const registry = `${prefix}:partitions`;
  const sequence = `${prefix}:sequence`;
  const partitionFor = (threadId: string): string =>
    `${prefix}:thread:${createHash("sha256").update(threadId).digest("hex")}`;
  let sweeping: Promise<void> | undefined;
  let disposed = false;

  const remove = async (partition: string, jobId: string): Promise<void> => {
    await client.eval(REMOVE, 4, registry, sequence, partition, `${partition}:parked`, jobId);
  };
  const advance = async (partition: string): Promise<void> => {
    // Bound stale-head cleanup too: the next sweep resumes if many failed/removed jobs accumulated.
    for (let index = 0; index < 100; index++) {
      const [head] = await client.zrange(partition, "0", "0");
      if (!head) return;
      const job = await queue.getJob(head);
      const state = job ? await job.getState() : "unknown";
      if (state === "unknown" || state === "completed" || state === "failed") {
        await remove(partition, head);
        continue;
      }
      // Only Skein's parked followers may be promoted. A delayed head can instead be in native
      // retry backoff. Consume the attempt marker atomically so competing reconcilers cannot issue
      // a second promotion after the first one has already let the head execute and fail.
      if (
        state === "delayed" &&
        (await client.eval(
          TAKE_PARKED,
          1,
          `${partition}:parked`,
          head,
          String(job!.attemptsStarted),
        )) === 1
      )
        await job!.promote().catch(() => undefined);
      return;
    }
  };
  const sweep = async (): Promise<void> => {
    for (const partition of await client.zrange(registry, "0", "99")) {
      await client.zadd(registry, "XX", Date.now(), partition);
      await advance(partition);
    }
  };
  const timer = setInterval(() => {
    if (disposed || sweeping) return;
    sweeping = sweep()
      .catch(() => undefined)
      .finally(() => {
        sweeping = undefined;
      });
  }, 1000);
  timer.unref();

  return {
    async dispatchRun(
      job: Job<QueuedRun>,
      token: string | undefined,
      tryProcess: (run: QueuedRun) => Promise<boolean>,
    ): Promise<void> {
      const partition = partitionFor(job.data.thread_id);
      const head = await client.eval(
        REGISTER,
        4,
        registry,
        sequence,
        partition,
        `${partition}:parked`,
        job.id!,
        Date.now(),
      );
      if (head !== job.id) {
        await job.moveToDelayed(Date.now() + 60_000, token);
        // Record only a successful native delay transition, and bind it to this dequeue attempt.
        // A failed hint write leaves the 60-second native backstop; it must not turn an already
        // delayed job into a processor failure or leave a stale marker for a later genuine retry.
        await client
          .eval(
            RECORD_PARKED,
            2,
            partition,
            `${partition}:parked`,
            job.id!,
            String(job.attemptsStarted),
          )
          .catch(() => undefined);
        throw new DelayedError();
      }
      if ((await tryProcess(job.data)) === false) {
        await job.moveToDelayed(Date.now() + 50, token);
        throw new DelayedError();
      }
      await remove(partition, job.id!);
      // Promotion is an optimization. The durable registry sweep also repairs a crash here.
      await advance(partition).catch(() => undefined);
    },
    async dispose(): Promise<void> {
      disposed = true;
      clearInterval(timer);
      await sweeping;
      await closeConnection(client);
    },
  };
}
