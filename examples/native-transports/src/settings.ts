import { resolve } from "node:path";

import { Redis } from "ioredis";

export const commandQueueName = process.env["SKEIN_COMMAND_QUEUE"] ?? "native-example-commands";
export const outcomeQueueName = process.env["SKEIN_OUTCOME_QUEUE"] ?? "native-example-outcomes";
export const sqlitePath = resolve(
  process.env["SKEIN_SQLITE_PATH"] ?? ".skein/native-example.sqlite",
);
export const receiverPath = resolve(process.env["SKEIN_RECEIVER_PATH"] ?? ".skein/receiver.sqlite");
export const commandId = process.env["SKEIN_COMMAND_ID"] ?? "approval-demo-1";
export const token = process.env["SKEIN_EXAMPLE_TOKEN"] ?? "local-example";

export function connectRedis() {
  return new Redis(process.env["REDIS_URI"] ?? "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: null,
  });
}
