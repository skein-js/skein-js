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

/**
 * A checkpoint pointer (time travel). Mirrors the SDK `Checkpoint` minus `thread_id` (which the
 * server sets from the path). Deliberately no `.uuid()` — skein does not constrain checkpoint/thread
 * id format, and LangGraph's `.uuid()` would reject skein's own ids. Strict (no `.passthrough()`) on
 * purpose: this object is spread into the graph's `configurable`, so unknown keys — notably a
 * server-owned `thread_id`/`run_id`/`langgraph_auth_*` — must be stripped here so a client can't
 * redirect a state write to another thread by smuggling them through the checkpoint pointer.
 */
const checkpointSchema = z.object({
  checkpoint_id: z.string().optional(),
  checkpoint_ns: z.string().nullish(),
  checkpoint_map: z.record(z.unknown()).nullish(),
});

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
    webhook: z
      .string()
      .url()
      // `URL` canonicalizes the value the server stores, dispatches, and logs. In particular it
      // removes embedded ASCII control characters that `z.string().url()` accepts via the platform
      // URL parser, preventing a caller from forging additional log lines with the original text.
      .transform((value) => new URL(value).href)
      .optional(),
    /**
     * What to do with a stateless run's server-created thread once it settles. Ignored for a
     * thread-scoped run. Defaults to `keep` — see `CreateRunInput.on_completion` for why skein's
     * default differs from LangGraph's.
     */
    on_completion: z.enum(["delete", "keep"]).optional(),
    /** Time travel: fork this run from a prior checkpoint instead of the thread tip. */
    checkpoint_id: z.string().optional(),
    /** Time travel: full checkpoint pointer to fork from (its `checkpoint_id` is what matters). */
    checkpoint: checkpointSchema.optional(),
  })
  .passthrough();

/**
 * `POST /runs/batch` — an array of stateless run-creates.
 *
 * Bounded, unlike LangGraph's unbounded `RunBatchCreate`: each element creates a thread, a run row and
 * a queue job, so one request is an N-fold write amplifier on the store and the queue. 100 is far more
 * than a client batches in practice and small enough that the burst stays inside a normal pool.
 * Exceeding it is a 400 with the flattened issues, like every other schema violation here.
 */
export const runBatchCreateSchema = z.array(runCreateSchema).min(1).max(100);

/**
 * `POST /runs/cancel` — `cancelMany`. Every selector is optional; an empty body means "every inflight
 * run on the server", which is the request the SDK's `cancelMany({})` sends.
 */
export const cancelManySchema = z
  .object({
    thread_id: z.string().min(1).optional(),
    run_ids: z.array(z.string().min(1)).optional(),
    /** `all` (the default) is every inflight run; the others narrow to that single status. */
    status: z.enum(["pending", "running", "all"]).optional(),
  })
  .passthrough();

/** `POST /threads/{id}/state` — update (fork) thread state at a checkpoint via `graph.updateState`. */
export const threadStateUpdateSchema = z
  .object({
    /** New state to write. `null` re-points `next` without changing values; an array is a bulk write. */
    values: z.union([z.record(z.unknown()), z.array(z.record(z.unknown()))]).nullish(),
    /** Attribute the update as though this node produced `values` (sets up which node runs next). */
    as_node: z.string().optional(),
    /** The checkpoint to fork from; omitted updates the thread tip. */
    checkpoint_id: z.string().optional(),
    /** Full checkpoint pointer to fork from (alternative to `checkpoint_id`). */
    checkpoint: checkpointSchema.nullish(),
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

/** `POST /threads/search`. `limit` is capped so a client can't request an unbounded page. */
export const threadSearchSchema = z
  .object({
    metadata: z.record(z.unknown()).optional(),
    values: z.record(z.unknown()).optional(),
    status: z.enum(["idle", "busy", "interrupted", "error"]).optional(),
    ids: z.array(z.string()).optional(),
    // Capped to match `assistantSearchSchema`. A thread row carries its full mirrored graph state, so
    // an unbounded page here is the most expensive one in the protocol. An *absent* limit is bounded
    // too — the drivers resolve it to a page rather than to every row.
    limit: z.number().int().positive().max(1000).optional(),
    offset: z.number().int().nonnegative().optional(),
    sort_by: z.enum(["thread_id", "status", "created_at", "updated_at"]).optional(),
    sort_order: z.enum(["asc", "desc"]).optional(),
  })
  .passthrough();

/**
 * `POST /threads/count` — the search filters without pagination or sort.
 *
 * Derived from {@link threadSearchSchema} rather than restated, so a filter added there reaches this
 * endpoint too. Restating them meant a new filter would be silently swallowed by `.passthrough()` and
 * ignored — a count that disagrees with its own listing, which is exactly the drift the driver-level
 * `threadSearchWhere` extraction exists to prevent one layer lower.
 */
export const threadCountSchema = threadSearchSchema.omit({
  limit: true,
  offset: true,
  sort_by: true,
  sort_order: true,
});

/**
 * `POST /threads/prune`.
 *
 * `thread_ids` is bounded for the same reason `runBatchCreateSchema` is: each entry is a delete (a
 * transaction, plus a cascade over the thread's runs) or a checkpoint delete-and-replay, so one request
 * with an unbounded list is an unbounded unit of work holding a connection.
 */
export const threadPruneSchema = z
  .object({
    thread_ids: z.array(z.string().min(1)).min(1).max(1000),
    strategy: z.enum(["delete", "keep_latest"]).optional(),
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

/**
 * `POST /threads/{id}/history`.
 *
 * Every field arrives in the **body**, not the query string — that is what the LangGraph SDK sends
 * (`json: { limit, before, metadata, checkpoint }`, with `limit` defaulting to 10). Reading `?limit`
 * instead means a real client's limit is silently dropped, which is how this endpoint came to drain a
 * thread's entire checkpoint history.
 *
 * `checkpoint` is accepted and ignored: `getStateHistory` has no equivalent option, and rejecting a
 * field the SDK always sends would 400 every call.
 */
export const threadHistorySchema = z
  .object({
    // Bounded harder than a search page: each element carries a full graph state, not a row.
    limit: z.number().int().positive().max(1000).optional(),
    /**
     * Read the history *before* this checkpoint — a config, or a bare checkpoint id.
     *
     * `configurable` is enumerated rather than passed through, matching `checkpointSchema` above: only
     * `checkpoint_id` reaches the checkpointer, so a client-supplied `thread_id` cannot ride along and
     * redirect the read at another thread. Today's savers read nothing else from `before`, so this loses
     * nothing — and it turns a bad `checkpoint_id` into a 400 here instead of an error thrown from inside
     * the saver, which surfaces as a 500.
     */
    before: z
      .union([
        z.string().min(1),
        z.object({ configurable: z.object({ checkpoint_id: z.string().min(1) }) }),
      ])
      .optional(),
    /** Keep only checkpoints whose metadata matches — `getStateHistory`'s `filter`. */
    metadata: z.record(z.unknown()).optional(),
    checkpoint: z.record(z.unknown()).optional(),
  })
  .optional();

/** `POST /store/items/search`. `limit` is capped so a client can't request an unbounded page. */
export const storeSearchSchema = z
  .object({
    namespace_prefix: z.array(z.string()).optional(),
    query: z.string().optional(),
    limit: z.number().int().positive().max(1000).optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .passthrough();

/** `POST /store/namespaces`. */
export const listNamespacesSchema = z
  .object({
    prefix: z.array(z.string()).optional(),
    limit: z.number().int().positive().max(1000).optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .passthrough();
