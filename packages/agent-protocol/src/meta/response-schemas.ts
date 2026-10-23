import { RUN_STATUSES } from "@skein-js/core";
import { z } from "zod";

import type { ProtocolHandlers } from "../create-handlers.js";

const metadata = z.record(z.unknown());
const timestamp = z.string();
const assistant = z
  .object({
    assistant_id: z.string(),
    graph_id: z.string(),
    name: z.string(),
    metadata,
    config: metadata,
    created_at: timestamp,
    updated_at: timestamp,
    version: z.number(),
  })
  .passthrough();
const thread = z
  .object({
    thread_id: z.string(),
    created_at: timestamp,
    updated_at: timestamp,
    metadata,
    status: z.string(),
    values: z.unknown(),
    interrupts: z.record(z.unknown()).optional(),
  })
  .passthrough();
const run = z
  .object({
    run_id: z.string(),
    thread_id: z.string(),
    assistant_id: z.string(),
    created_at: timestamp,
    updated_at: timestamp,
    status: z.enum(RUN_STATUSES as [string, ...string[]]),
    metadata,
    kwargs: metadata.optional(),
  })
  .passthrough();
const checkpoint = z
  .object({
    checkpoint_id: z.string().nullish(),
    checkpoint_ns: z.string().optional(),
    checkpoint_map: z.record(z.string()).optional(),
  })
  .passthrough();
const state = z
  .object({
    values: z.unknown(),
    next: z.array(z.string()),
    checkpoint,
    metadata: z.unknown(),
    tasks: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
  })
  .passthrough();
const cron = z
  .object({
    cron_id: z.string(),
    assistant_id: z.string(),
    thread_id: z.string().nullish(),
    schedule: z.string(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .passthrough();
const item = z
  .object({
    namespace: z.array(z.string()),
    key: z.string(),
    value: metadata,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .passthrough();
const size = z.object({ count: z.number().nonnegative(), bytes: z.number().nonnegative() });
const storage = z.object({
  thread_id: z.string(),
  total_bytes: z.number().nonnegative(),
  checkpoints: size,
  pending_writes: size,
  channel_values: size.extend({
    by_channel: z.record(
      z.object({ versions: z.number().nonnegative(), bytes: z.number().nonnegative() }),
    ),
  }),
});

/** Describes existing wire responses; search projections deliberately make selected fields optional. */
export const responseSchemas: Partial<Record<keyof ProtocolHandlers, z.ZodTypeAny>> = {
  createThread: thread,
  getThread: thread,
  patchThread: thread,
  copyThread: thread,
  listThreads: z.array(thread.partial()),
  createAssistant: assistant,
  getAssistant: assistant,
  updateAssistant: assistant,
  setAssistantLatestVersion: assistant,
  searchAssistants: z.array(assistant.partial()),
  listAssistantVersions: z.array(assistant),
  createBackgroundRun: run,
  createStatelessRun: run,
  getRun: run,
  listThreadRuns: z.array(run),
  createRunBatch: z.array(run),
  getThreadState: state,
  getThreadStateAtCheckpoint: state,
  getThreadStateAtCheckpointFromBody: state,
  getThreadHistory: z.array(state),
  getThreadStorage: storage,
  updateThreadState: z.object({ checkpoint }),
  createCron: cron,
  getCron: cron,
  updateCron: cron,
  searchCrons: z.array(cron.partial()),
  getStoreItem: item.nullable(),
  searchStoreItems: z.object({ items: z.array(item) }),
  listStoreNamespaces: z.object({ namespaces: z.array(z.array(z.string())) }),
  countThreads: z.number(),
  countAssistants: z.number(),
  countCrons: z.number(),
  postThreadCommands: z.object({
    id: z.union([z.string(), z.number()]),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  }),
};
