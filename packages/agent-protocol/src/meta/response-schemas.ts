import { RUN_STATUSES, type RunStatus } from "@skein-js/core";
import { z } from "zod";

const metadata = z.record(z.unknown());
const timestamp = z.string();
export const assistant = z
  .object({
    assistant_id: z.string(),
    graph_id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    context: z.unknown(),
    metadata: metadata.nullish(),
    config: metadata,
    created_at: timestamp,
    updated_at: timestamp,
    version: z.number(),
  })
  .passthrough();
export const interrupt = z
  .object({
    id: z.string().optional(),
    value: z.unknown().optional(),
    when: z.string().optional(),
    resumable: z.boolean().optional(),
    ns: z.array(z.string()).optional(),
  })
  .passthrough();
export const thread = z
  .object({
    ttl: z.number().nullable().optional(),
    expires_at: timestamp.nullable().optional(),
    ttl_strategy: z.enum(["delete", "keep_latest"]).optional(),
    thread_id: z.string(),
    state_updated_at: timestamp.optional(),
    config: metadata.optional(),
    error: z.union([z.string(), metadata]).nullish(),
    extracted: metadata.optional(),
    created_at: timestamp,
    updated_at: timestamp,
    metadata: metadata.nullish(),
    status: z.string(),
    values: z.unknown(),
    interrupts: z.record(z.array(interrupt)).optional(),
  })
  .passthrough();
export const run = z
  .object({
    run_id: z.string(),
    thread_id: z.string(),
    assistant_id: z.string(),
    created_at: timestamp,
    updated_at: timestamp,
    status: z.enum(RUN_STATUSES as [RunStatus, ...RunStatus[]]),
    metadata: metadata.nullish(),
    multitask_strategy: z
      .enum(["reject", "interrupt", "rollback", "enqueue"])
      .nullable()
      .optional(),
    error: z
      .object({
        error: z.string(),
        message: z.string(),
        name: z.string(),
        stack: z.string().optional(),
        cause: z.unknown().optional(),
        errors: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export const checkpoint = z
  .object({
    thread_id: z.string().optional(),
    checkpoint_id: z.string().nullish(),
    checkpoint_ns: z.string().optional(),
    checkpoint_map: z.record(z.unknown()).nullish(),
  })
  .passthrough();
export const task = z
  .object({
    id: z.string(),
    name: z.string(),
    result: z.unknown().optional(),
    error: z.string().nullish(),
    interrupts: z.array(interrupt),
    checkpoint: checkpoint.nullish(),
    state: z.unknown().optional(),
  })
  .passthrough();
export const state = z
  .object({
    values: z.unknown(),
    next: z.array(z.string()),
    checkpoint,
    created_at: timestamp.nullish(),
    parent_checkpoint: checkpoint.nullish(),
    metadata: z.unknown(),
    tasks: z.array(task),
  })
  .passthrough();
export const cron = z
  .object({
    cron_id: z.string(),
    assistant_id: z.string(),
    thread_id: z.string().nullish(),
    schedule: z.string(),
    on_run_completed: z.enum(["delete", "keep"]).optional(),
    end_time: timestamp.nullish(),
    timezone: z.string().nullish(),
    payload: metadata,
    user_id: z.string().nullish(),
    next_run_date: timestamp.nullish(),
    metadata,
    enabled: z.boolean(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .passthrough();
export const item = z
  .object({
    ttl: z.number().nullable().optional(),
    expires_at: timestamp.nullable().optional(),
    namespace: z.array(z.string()),
    key: z.string(),
    value: metadata,
    score: z.number().optional(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .passthrough();
const size = z.object({ count: z.number().nonnegative(), bytes: z.number().nonnegative() });
export const storage = z.object({
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
