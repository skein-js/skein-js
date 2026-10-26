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
return redis.call('ZRANGE', KEYS[3], 0, 0)[1]
`;
const REMOVE = `
redis.call('ZREM', KEYS[3], ARGV[1])
local head = redis.call('ZRANGE', KEYS[3], 0, 0)[1]
if not head then
  redis.call('DEL', KEYS[3])
  redis.call('ZREM', KEYS[1], KEYS[3])
  if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1], KEYS[2]) end
end
return head
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
    await client.eval(REMOVE, 3, registry, sequence, partition, jobId);
  };
  const advance = async (partition: string): Promise<void> => {
    // Bound stale-head cleanup too: the next sweep resumes if many failed/removed jobs accumulated.
    for (let index = 0; index < 100; index++) {
      const [head] = await client.zrange(partition, 0, 0);
      if (!head) return;
      const job = await queue.getJob(head);
      const state = job ? await job.getState() : "unknown";
      if (state === "unknown" || state === "completed" || state === "failed") {
        await remove(partition, head);
        continue;
      }
      // Registration only happens after the original delay elapsed. Promotion cannot shorten it.
      if (state === "delayed") await job!.promote().catch(() => undefined);
      return;
    }
  };
  const sweep = async (): Promise<void> => {
    for (const partition of await client.zrange(registry, 0, 99)) {
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
    async process(
      job: Job<QueuedRun>,
      token: string | undefined,
      tryProcess: (run: QueuedRun) => Promise<boolean>,
    ): Promise<void> {
      const partition = partitionFor(job.data.thread_id);
      const head = await client.eval(
        REGISTER,
        3,
        registry,
        sequence,
        partition,
        job.id!,
        Date.now(),
      );
      if (head !== job.id) {
        await job.moveToDelayed(Date.now() + 60_000, token);
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
