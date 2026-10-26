import process from "node:process";

import { RedisRunQueue } from "@skein-js/redis";

const queue = new RedisRunQueue(process.env.REDIS_URI, { queueName: process.env.QUEUE_NAME });
queue.consumePartitioned(async (run) => {
  process.send?.(run.run_id);
  await new Promise(() => {});
  return true;
});
