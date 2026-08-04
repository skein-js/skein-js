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
    /**
     * What to do when the named thread does not exist. `reject` (the default, and LangGraph's) 404s;
     * `create` brings the thread into existence and runs against it.
     *
     * The SDK's own doc comment says "if the specified **run** doesn't exist" — an upstream typo. The
     * field is about the thread; there is no run to speak of before this call creates one.
     *
     * Inert on `POST /runs` and `/runs/batch`, which strip `thread_id` outright: the server owns a
     * stateless run's thread, so there is never a named thread to be missing.
     */
    if_not_exists: z.enum(["create", "reject"]).optional(),
    /**
     * Hold the run this long before starting it — the SDK's "schedule a future run".
     *
     * Capped at a day, like every other numeric input here. An unbounded delay is a run row pinning its
     * thread against `multitask_strategy: "reject"` for as long as it sits there, and on the inline
     * routes an HTTP connection held open to match. A schedule measured in days is a cron.
     */
    after_seconds: z.number().int().nonnegative().max(86_400).optional(),
    /**
     * What to do when the client drops the connection mid-run: `cancel` settles the run, `continue`
     * (the default) lets it finish.
     *
     * Only meaningful on the inline routes — `/runs/wait` and `/runs/stream` — which are the only ones
     * holding a connection to drop. The SDK does not send it on a background create for that reason.
     *
     * `continue` is the default deliberately, even though `useStream` sends `cancel`: a proxy idle
     * timeout or load-balancer reset is indistinguishable from a real disconnect here, and defaulting
     * to cancel would let one kill a healthy run.
     */
    on_disconnect: z.enum(["cancel", "continue"]).optional(),
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
    /** Conflict policy when `thread_id` already exists; defaults to `raise`. */
    if_exists: z.enum(["raise", "do_nothing"]).optional(),
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
 * `POST /threads/{id}/state/checkpoint` — read state at a checkpoint given as an **object**.
 *
 * The SDK's `threads.getState(id, checkpoint)` picks its route from the argument's type: a bare
 * string id goes to `GET /threads/{id}/state/{checkpoint_id}`, while a checkpoint object is POSTed
 * here. Only `checkpoint_id` is read from the pointer (see `checkpointSchema`) — enumerated rather
 * than passed through so a client cannot smuggle a `thread_id` in and redirect the read.
 *
 * `checkpoint` is nullish and may carry no id: `@langchain/langgraph-api` spreads it into
 * `configurable` and lets the checkpointer resolve the tip, so an absent pointer means "current
 * state" rather than an error.
 *
 * `subgraphs` is accepted and ignored, matching the sibling GET route — the thread service reads a
 * single namespace, and rejecting a field the SDK always sends would 400 every call.
 */
export const threadStateCheckpointSchema = z
  .object({
    checkpoint: checkpointSchema.nullish(),
    subgraphs: z.boolean().optional(),
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

/**
 * The run-shaped half of a cron body: what each fire replays. A superset of what the SDK sends on
 * `crons.create`, and stored verbatim as `Cron.payload`.
 *
 * `assistant_id` is absent here — it lives on the cron row itself, and the SDK passes it as a
 * separate argument rather than in the payload.
 */
const cronRunPayloadSchema = z.object({
  input: z.unknown().optional(),
  command: commandSchema.optional(),
  config: configSchema.optional(),
  context: z.unknown().optional(),
  stream_mode: streamModeSchema.optional(),
  multitask_strategy: multitaskStrategySchema.optional(),
  interrupt_before: interruptWhenSchema.optional(),
  interrupt_after: interruptWhenSchema.optional(),
  webhook: z
    .string()
    .url()
    .transform((value) => new URL(value).href)
    .optional(),
  checkpoint_id: z.string().optional(),
  /**
   * Accepted and ignored, like the SDK's other forward-looking run knobs. Named explicitly rather
   * than swallowed by `.passthrough()` so a reader can see they were considered.
   */
  checkpoint_during: z.boolean().optional(),
  durability: z.string().optional(),
  stream_subgraphs: z.boolean().optional(),
  stream_resumable: z.boolean().optional(),
});

/**
 * `POST /runs/crons` and `POST /threads/{thread_id}/runs/crons`.
 *
 * One schema for both, because the SDK sends the same body to both: the OpenAPI spec splits
 * `CronCreate` (which has `on_run_completed`) from `ThreadCronCreate` (which has
 * `multitask_strategy`), but `@langchain/langgraph-sdk` sends both fields on both routes. Accepting
 * the union is what keeps the official client working; the service then resolves which of them
 * actually applies from whether a thread was named.
 */
export const cronCreateSchema = cronRunPayloadSchema
  .extend({
    assistant_id: z.string().min(1),
    /** Validated as a real 5-field expression by the service, which owns the cron parser. */
    schedule: z.string().min(1),
    /** Folded in from the path on the thread-scoped route (`foldThreadIdIntoBody`). */
    thread_id: z.string().min(1).optional(),
    /** IANA zone; `null` means UTC. */
    timezone: z.string().min(1).nullish(),
    end_time: z.string().datetime({ offset: true }).nullish(),
    enabled: z.boolean().optional(),
    /** Only meaningful for a stateless cron; the service ignores it for a thread cron. */
    on_run_completed: z.enum(["delete", "keep"]).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

/**
 * `PATCH /runs/crons/{cron_id}`.
 *
 * Every nullable field is `.nullish()` rather than `.optional()`, and that distinction is the whole
 * contract: omitted leaves the stored value, an explicit `null` clears it. The wire spec says so for
 * `end_time` ("send null to clear a previously set end time; omit to leave it unchanged"), and Zod
 * is where the two are told apart — by the time the service sees the object, `undefined` and `null`
 * have to still mean different things.
 */
export const cronUpdateSchema = cronRunPayloadSchema
  .extend({
    schedule: z.string().min(1).optional(),
    timezone: z.string().min(1).nullish(),
    end_time: z.string().datetime({ offset: true }).nullish(),
    enabled: z.boolean().optional(),
    on_run_completed: z.enum(["delete", "keep"]).optional(),
    /** MERGES into the stored metadata rather than replacing it, matching LangGraph. */
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

/**
 * `POST /runs/crons/search`.
 *
 * `sort_by` accepts the union of the SDK's `CronSortBy` and the OpenAPI spec's enum (which also
 * allows `end_time`), so a client written against either gets the sort it asked for rather than a
 * silent fallback to `created_at`.
 */
export const cronSearchSchema = z
  .object({
    assistant_id: z.string().min(1).optional(),
    thread_id: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
    limit: z.number().int().positive().max(1000).optional(),
    offset: z.number().int().nonnegative().optional(),
    sort_by: z
      .enum([
        "cron_id",
        "assistant_id",
        "thread_id",
        "created_at",
        "updated_at",
        "next_run_date",
        "end_time",
      ])
      .optional(),
    sort_order: z.enum(["asc", "desc"]).optional(),
    /**
     * Field projection. Validated so a typo is a 400 rather than silence, then ignored: skein always
     * returns the full `Cron`. Projection saves nothing on a row this small, and the SDK's enum
     * includes a pseudo-field (`now`) whose server-side meaning LangGraph does not document —
     * inventing semantics for it would be worse than honestly not implementing it.
     */
    select: z
      .array(
        z.enum([
          "cron_id",
          "assistant_id",
          "thread_id",
          "end_time",
          "schedule",
          "created_at",
          "updated_at",
          "user_id",
          "payload",
          "next_run_date",
          "metadata",
          "now",
          "timezone",
          "enabled",
          "on_run_completed",
        ]),
      )
      .optional(),
  })
  .passthrough();

/**
 * `POST /runs/crons/count` — the search filters without pagination, sort, or projection. Derived
 * from {@link cronSearchSchema} for the same reason {@link threadCountSchema} is derived.
 */
export const cronCountSchema = cronSearchSchema.omit({
  limit: true,
  offset: true,
  sort_by: true,
  sort_order: true,
  select: true,
});
