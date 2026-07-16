// Minimal, protocol-owned Zod schemas for inbound bodies. We deliberately do NOT pull in
// `@langchain/langgraph-api`'s schemas: the wire *types* already come from the SDK, and this
// package stays lean. Schemas are permissive where the protocol is (unknown `input`/`context`,
// pass-through extras) and strict where correctness depends on it (`assistant_id`, store keys).

import { z } from "zod";

const commandSchema = z
  .object({
    resume: z.unknown().optional(),
    update: z.unknown().optional(),
    goto: z.unknown().optional(),
  })
  .passthrough();

const streamModeSchema = z.union([z.string(), z.array(z.string())]);

const configSchema = z.record(z.unknown());

const multitaskStrategySchema = z.enum(["reject", "interrupt", "rollback", "enqueue"]);

const interruptWhenSchema = z.union([z.array(z.string()), z.literal("*")]);

/** `POST /runs/wait`, `POST /runs/stream`, `POST /threads/{id}/runs`. */
export const runCreateSchema = z
  .object({
    assistant_id: z.string().min(1),
    thread_id: z.string().min(1).optional(),
    input: z.unknown().optional(),
    command: commandSchema.optional(),
    config: configSchema.optional(),
    context: z.unknown().optional(),
    stream_mode: streamModeSchema.optional(),
    metadata: z.record(z.unknown()).optional(),
    multitask_strategy: multitaskStrategySchema.optional(),
    interrupt_before: interruptWhenSchema.optional(),
    interrupt_after: interruptWhenSchema.optional(),
    /** Run-completion webhook: an absolute `http(s)` URL POSTed the settled run when it finishes. */
    webhook: z.string().url().optional(),
  })
  .passthrough();

/** `POST /threads/{id}/stream` — like a run create, but the thread id comes from the path. */
export const threadStreamSchema = z
  .object({
    assistant_id: z.string().min(1),
    input: z.unknown().optional(),
    config: configSchema.optional(),
    context: z.unknown().optional(),
    stream_mode: streamModeSchema.optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

/** `POST /threads/{id}/commands` — resume/goto/update for an interrupted thread. */
export const commandBodySchema = z
  .object({
    assistant_id: z.string().min(1).optional(),
    command: commandSchema.optional(),
    resume: z.unknown().optional(),
    stream_mode: streamModeSchema.optional(),
    config: configSchema.optional(),
    context: z.unknown().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

/** `POST /threads`. */
export const threadCreateSchema = z
  .object({
    thread_id: z.string().min(1).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

/** `PATCH /threads/{id}`. */
export const threadPatchSchema = z
  .object({
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

/** `POST /threads/search`. */
export const threadSearchSchema = z
  .object({
    metadata: z.record(z.unknown()).optional(),
    values: z.record(z.unknown()).optional(),
    status: z.enum(["idle", "busy", "interrupted", "error"]).optional(),
    ids: z.array(z.string()).optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
    sort_by: z.enum(["thread_id", "status", "created_at", "updated_at"]).optional(),
    sort_order: z.enum(["asc", "desc"]).optional(),
  })
  .passthrough();

/** `POST /assistants`. */
export const assistantCreateSchema = z
  .object({
    graph_id: z.string().min(1),
    assistant_id: z.string().min(1).optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    config: configSchema.optional(),
    context: z.unknown().optional(),
    metadata: z.record(z.unknown()).optional(),
    /** Conflict policy when `assistant_id` already exists; defaults to `raise`. */
    if_exists: z.enum(["raise", "do_nothing"]).optional(),
  })
  .passthrough();

/** `PATCH /assistants/{id}` — every field optional; each patch mints a new version. */
export const assistantUpdateSchema = z
  .object({
    graph_id: z.string().min(1).optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    config: configSchema.optional(),
    context: z.unknown().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

/** `POST /assistants/search`. `limit` is capped so a client can't request an unbounded page. */
export const assistantSearchSchema = z
  .object({
    graph_id: z.string().optional(),
    name: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    limit: z.number().int().positive().max(1000).optional(),
    offset: z.number().int().nonnegative().optional(),
    sort_by: z.enum(["assistant_id", "graph_id", "name", "created_at", "updated_at"]).optional(),
    sort_order: z.enum(["asc", "desc"]).optional(),
  })
  .passthrough();

/** `POST /assistants/count` — the search filters without pagination/sort. */
export const assistantCountSchema = z
  .object({
    graph_id: z.string().optional(),
    name: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

/** `POST /assistants/{id}/versions`. `limit` is capped to bound the response size. */
export const assistantVersionsSchema = z
  .object({
    metadata: z.record(z.unknown()).optional(),
    limit: z.number().int().positive().max(1000).optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .passthrough();

/** `POST /assistants/{id}/latest`. */
export const assistantSetLatestSchema = z
  .object({
    version: z.number().int().positive(),
  })
  .passthrough();

/** `PUT /store/items`. */
export const storePutSchema = z
  .object({
    namespace: z.array(z.string()).min(1),
    key: z.string().min(1),
    value: z.record(z.unknown()),
    /** Optional item lifetime in minutes; overrides the configured `store.ttl.default_ttl`. */
    ttl: z.number().positive().optional(),
  })
  .passthrough();

/** `POST /store/items/search`. */
export const storeSearchSchema = z
  .object({
    namespace_prefix: z.array(z.string()).optional(),
    query: z.string().optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .passthrough();

/** `POST /store/namespaces`. */
export const listNamespacesSchema = z
  .object({
    prefix: z.array(z.string()).optional(),
  })
  .passthrough();
