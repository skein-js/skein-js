// `SkeinStore` — the durable home for Agent Protocol *resources* (assistants, threads, runs,
// long-term store items). This is deliberately NOT LangGraph's checkpointer: graph state and
// history stay 100% LangGraph-native via a `BaseCheckpointSaver`. SkeinStore owns only the
// resource rows that OSS keeps in memory (see docs/storage.md).
//
// Every driver (memory, postgres, …) implements this one interface and is held to the shared
// conformance suite, so they behave identically. Methods return the wire types from
// `../wire`, so a handler can pass a repo result straight to the client.

import type { AuthUser } from "../auth/auth.js";
import type { RunError } from "../errors/run-error.js";
import type {
  Assistant,
  AssistantVersion,
  Config,
  Cron,
  CronSortBy,
  DefaultValues,
  Interrupt,
  Item,
  Metadata,
  MultitaskStrategy,
  Run,
  RunStatus,
  SearchItem,
  StreamMode,
  Thread,
  ThreadStatus,
} from "../wire/wire.js";

// --- assistants ---------------------------------------------------------------------------

/** Fields accepted when registering an assistant (from a langgraph.json graph or the API). */
export interface AssistantCreate {
  graph_id: string;
  /** Server-assigned when omitted. */
  assistant_id?: string;
  name?: string;
  description?: string;
  config?: Config;
  context?: unknown;
  metadata?: Metadata;
}

/**
 * Partial update; omitted fields keep the current version's value. Every update mints a NEW
 * immutable version (see {@link AssistantRepo.update}) — there is no in-place field mutation.
 */
export interface AssistantUpdate {
  graph_id?: string;
  name?: string;
  description?: string;
  config?: Config;
  context?: unknown;
  metadata?: Metadata;
}

/** Filter + pagination for `POST /assistants/search`. Omitted fields don't constrain the result. */
export interface AssistantSearchQuery {
  /** Restrict to assistants of this graph. */
  graph_id?: string;
  /** Restrict to assistants with this exact name. */
  name?: string;
  /** Match assistants whose metadata contains every one of these key/value pairs (subset match). */
  metadata?: Metadata;
  limit?: number;
  offset?: number;
  /** Sort key; defaults to `created_at`. */
  sortBy?: "assistant_id" | "graph_id" | "name" | "created_at" | "updated_at";
  /** Sort direction; defaults to `desc`. */
  sortOrder?: "asc" | "desc";
}

/** Filter + pagination for `POST /assistants/{id}/versions`. */
export interface AssistantVersionsQuery {
  /** Match versions whose metadata contains every one of these key/value pairs (subset match). */
  metadata?: Metadata;
  limit?: number;
  offset?: number;
}

export interface AssistantRepo {
  list(): Promise<Assistant[]>;
  /** Filtered + paginated listing backing `POST /assistants/search`. */
  search(query: AssistantSearchQuery): Promise<Assistant[]>;
  /** Number of assistants matching `query` (ignores limit/offset), backing `POST /assistants/count`. */
  count(query: AssistantSearchQuery): Promise<number>;
  get(assistantId: string): Promise<Assistant | null>;
  /**
   * Create an assistant, seeding version 1 (the live row and its first {@link AssistantVersion}
   * snapshot are written together). Throws `SkeinHttpError.conflict` (409) when `assistant_id` is
   * already taken — the service layer turns that into `if_exists` handling, and callers that want
   * idempotent registration (e.g. graph auto-registration) get-before-create and tolerate the 409.
   */
  create(input: AssistantCreate): Promise<Assistant>;
  /**
   * Apply a partial patch by minting a NEW version: snapshot the current fields with `patch` applied,
   * bump the live row to those fields + the new version number. Throws `SkeinHttpError.notFound` when
   * the assistant is unknown. Returns the (now-active) assistant.
   */
  update(assistantId: string, patch: AssistantUpdate): Promise<Assistant>;
  /** Version history, newest-first, filtered + paginated. Empty when the assistant is unknown. */
  listVersions(assistantId: string, query?: AssistantVersionsQuery): Promise<AssistantVersion[]>;
  /**
   * Roll the live row back to an existing version's snapshot (no new version is minted). Throws
   * `SkeinHttpError.notFound` when the assistant or the target version is unknown.
   */
  setLatest(assistantId: string, version: number): Promise<Assistant>;
  delete(assistantId: string): Promise<void>;
}

// --- threads ------------------------------------------------------------------------------

/**
 * Expiry policy for threads (from `langgraph.json` `checkpointer.ttl`). Durations are in minutes,
 * matching {@link StoreTtlConfig}.
 *
 * A driver applies `defaultTtl` when a thread is created without its own `ttl`, and the thread TTL
 * sweeper deletes threads whose expiry has passed via {@link ThreadRepo.listExpired}.
 *
 * Unlike store items, an expired thread is **not** hidden on read: expiry here means "eligible for
 * deletion", and a thread is a container for runs and checkpoints rather than a single row. Hiding it
 * early would make a thread with an in-flight run read as absent while that run was still writing to it.
 */
export interface ThreadTtlConfig {
  /** Default thread lifetime in minutes when a create passes no `ttl`. */
  defaultTtl?: number;
  /** Sweeper cadence in minutes. Defaults to 60. */
  sweepIntervalMinutes?: number;
}

export interface ThreadCreate {
  /** Server-assigned when omitted. */
  thread_id?: string;
  metadata?: Metadata;
  status?: ThreadStatus;
  /**
   * This thread's lifetime in minutes, overriding the configured `defaultTtl`. `null` pins the thread
   * so no TTL ever expires it.
   */
  ttl?: number | null;
}

/** Partial update; omitted fields are left unchanged. */
export interface ThreadUpdate {
  metadata?: Metadata;
  status?: ThreadStatus;
  /** New lifetime in minutes; `null` clears the expiry so no TTL removes this thread. */
  ttl?: number | null;
  /** Latest graph state values mirrored onto the thread row. */
  values?: DefaultValues;
  /** Pending human-in-the-loop interrupts, mirrored from the graph state onto the thread row. */
  interrupts?: Record<string, Interrupt[]>;
  /**
   * Why the thread is in `status: "error"` — the SDK's `Thread.error`, which skein previously left
   * empty in favour of a `metadata.error` key. Set alongside an `error` status and cleared when the
   * thread recovers. Like the thread's status, this is a mirror of the *latest* turn; the durable
   * per-run record is `Run.error`. Pass `null` to clear it.
   */
  error?: string | null;
}

/** Filter + pagination for `POST /threads/search`. Omitted fields don't constrain the result. */
export interface ThreadSearchQuery {
  /** Match threads whose metadata contains every one of these key/value pairs (subset match). */
  metadata?: Metadata;
  /**
   * A **second** metadata subset, AND-ed with `metadata` — the server's own scoping, not the caller's.
   *
   * Separate from `metadata` rather than merged into it for two reasons. A merge would silently drop one
   * side on a key collision (a caller filtering `owner: "bob"` under an ownership filter of
   * `owner: "alice"` must match *nothing*, not one or the other), and this field is set by the server
   * only — a value arriving from a request body is discarded, so it cannot be widened from outside.
   *
   * Used by the auth ownership filter, which previously read every matching row and filtered in JS.
   * Both drivers apply it with the same containment semantics as `metadata`.
   */
  enforcedMetadata?: Metadata;
  /** Match threads whose mirrored graph values contain every one of these key/value pairs. */
  values?: DefaultValues;
  /** Restrict to threads in this status. */
  status?: ThreadStatus;
  /** Restrict to these thread ids. */
  ids?: string[];
  limit?: number;
  offset?: number;
  /** Sort key; defaults to `created_at`. */
  sortBy?: "thread_id" | "status" | "created_at" | "updated_at";
  /** Sort direction; defaults to `desc`. */
  sortOrder?: "asc" | "desc";
}

export interface ThreadRepo {
  list(): Promise<Thread[]>;
  /** Filtered + paginated listing backing `POST /threads/search`. */
  search(query: ThreadSearchQuery): Promise<Thread[]>;
  /**
   * Number of threads matching `query` (ignoring limit/offset), backing `POST /threads/count`.
   *
   * Counted independently of {@link search} rather than by measuring its result: `search` resolves an
   * absent limit to one *page*, so counting through it would report at most a page's worth. Both
   * drivers honour `enforcedMetadata` here too, so an auth-scoped count sees only the caller's threads.
   */
  count(query: ThreadSearchQuery): Promise<number>;
  get(threadId: string): Promise<Thread | null>;
  /**
   * Create a thread. Throws `SkeinHttpError.conflict` (409) when `thread_id` is already taken — the
   * service layer turns that into `if_exists` handling, and callers that want get-or-create (the run
   * service's `ensureThread`) tolerate the 409 and re-read. Enforced in the driver rather than by a
   * read-then-write in the service, so two instances racing the same id cannot both win.
   */
  create(input?: ThreadCreate): Promise<Thread>;
  update(threadId: string, patch: ThreadUpdate): Promise<Thread>;
  /** Duplicate a thread's row (new id, fresh timestamps); checkpoint history is copied at the service layer. */
  copy(threadId: string): Promise<Thread>;
  delete(threadId: string): Promise<void>;
  /**
   * Ids of threads whose TTL has expired, oldest expiry first — what the thread TTL sweeper deletes.
   *
   * Returns **ids, not rows**: the sweeper deletes each through the thread service so an in-flight run
   * is aborted and the runs/checkpoints cascade, which a driver-level `DELETE` would skip. Bounded by
   * `limit` (and the driver's own page cap) so one sweep is a bounded unit of work.
   *
   * Empty when TTL is unconfigured or nothing has expired.
   */
  listExpired(query: { now: string; limit: number }): Promise<string[]>;
}

/**
 * True if `subject` contains `filter`, mirroring Postgres' JSONB `@>` operator so the memory driver,
 * the conformance suite, and the Postgres driver all agree on metadata/values matching. Containment is
 * recursive: an object matches on a *subset* of its keys (nested objects included), an array matches as
 * a set (every filter element is contained in some subject element), and scalars match by equality. An
 * empty (or absent) filter matches everything.
 */
export function isMetadataSubset(subject: unknown, filter: unknown): boolean {
  if (filter === undefined || filter === null) return true;
  return jsonbContains(subject, filter);
}

function jsonbContains(subject: unknown, filter: unknown): boolean {
  // Scalars (and null): plain equality, like `'1'::jsonb @> '1'::jsonb`.
  if (filter === null || typeof filter !== "object") return subject === filter;
  // Array filter: every element must be contained in some element of the subject array (set semantics).
  if (Array.isArray(filter)) {
    if (!Array.isArray(subject)) return false;
    return filter.every((wanted) => subject.some((candidate) => jsonbContains(candidate, wanted)));
  }
  // Object filter: match on a subset of keys, recursively. An empty object matches any value.
  const entries = Object.entries(filter as Record<string, unknown>);
  if (entries.length === 0) return true;
  if (subject === null || typeof subject !== "object" || Array.isArray(subject)) return false;
  const row = subject as Record<string, unknown>;
  return entries.every(([key, value]) => key in row && jsonbContains(row[key], value));
}

// --- runs ---------------------------------------------------------------------------------

/**
 * The execution payload of a run — everything the run engine needs to (re)start a graph. Stored
 * *opaquely* alongside the run (it is NOT part of the wire {@link Run}), so a background run picked
 * up later, or a run reclaimed after a crash, can be reconstructed from just its `run_id`.
 */
export interface RunKwargs {
  /** Graph input for a fresh turn. Absent when the run is a resume (see {@link command}). */
  input?: unknown;
  /** A LangGraph command (e.g. `{ resume }`) — present when resuming an interrupted thread. */
  command?: { resume?: unknown; update?: unknown; goto?: unknown };
  config?: Config;
  context?: unknown;
  /** Requested stream modes; the engine normalizes these to graph modes. */
  stream_mode?: StreamMode | StreamMode[];
  interrupt_before?: string[] | "*";
  interrupt_after?: string[] | "*";
  /**
   * Optional run-completion webhook URL (absolute `http(s)`). When set, the run engine POSTs the
   * settled run (status + final values) to it once the run reaches a terminal status — matching
   * `@langchain/langgraph-api`. Persisted opaquely so a background/crash-recovered run still fires.
   */
  webhook?: string;
  /**
   * The authenticated caller, stamped by the server (never accepted from the client). Persisted
   * opaquely with the run so a background/crash-recovered run on another instance reconstructs the
   * principal via `getKwargs` and injects it into the graph's `configurable.langgraph_auth_user`.
   */
  auth_user?: AuthUser;
  /**
   * The caller's authenticated permission scopes (the `AuthContext.scopes`), stamped alongside
   * {@link auth_user}. Injected as `configurable.langgraph_auth_permissions`, matching LangGraph
   * (which sources permissions from the auth scopes, not from the user object's `permissions`).
   */
  auth_scopes?: string[];
  /**
   * The thread's checkpoint tip when this run *started executing* — what a later
   * `multitask_strategy: "rollback"` (or `cancel?action=rollback`) reverts the thread to.
   *
   * Three-valued on purpose: **absent** means never recorded, so a rollback must not touch the
   * checkpoints at all (the read failed, or the run never started — reverting on a guess would destroy
   * history this run never wrote); **null** means the thread genuinely had no checkpoints, so a
   * rollback wipes it; a **string** is the checkpoint to trim back to.
   *
   * Persisted, rather than held in a per-process map, so the instance that displaces a run can revert
   * its writes even when a *different* instance executed it. Written by
   * {@link RunRepo.recordBaseCheckpoint} at the `pending -> running` transition.
   */
  base_checkpoint_id?: string | null;
  /**
   * Work this run must do to the thread *before* it executes: drop a displaced run's checkpoint writes
   * and delete its rows. Set at create time by a `rollback` run, and carried here — rather than in a
   * per-process map — so whichever instance ends up executing this run applies it.
   */
  rollback_plan?: {
    /** `false` when no displaced run had written anything, so only the rows are removed. */
    revert_to_checkpoint: { base_checkpoint_id: string | null } | false;
    displaced_run_ids: string[];
  };
  /**
   * Delete this run's thread once the run settles — the resolved form of the request's
   * `on_completion`.
   *
   * A **decision, not the request field**: `on_completion` only means anything for a *stateless* run
   * (one whose thread the server created for it), and whether that was the case is knowable only at
   * create time. Resolving it there and persisting the answer keeps the engine from having to
   * re-derive "was this thread mine?" from a run row that no longer says.
   *
   * Persisted opaquely so a background or crash-recovered run still cleans up after itself.
   */
  delete_thread_on_completion?: boolean;
  /**
   * Time-travel fork target: the checkpoint this run branches from instead of the thread tip.
   * Server-owned — stamped from the validated top-level `checkpoint_id` on the run-create body,
   * never merged from the client's `config.configurable` (which strips it). Injected into
   * `configurable.checkpoint_id` by `toGraphCallOptions`. Persisted opaquely so a background or
   * crash-recovered run forks from the same checkpoint when reconstructed via `getKwargs`.
   */
  checkpoint_id?: string;
}

export interface RunCreate {
  thread_id: string;
  assistant_id: string;
  /** Server-assigned when omitted. */
  run_id?: string;
  /** Defaults to `"pending"`. */
  status?: RunStatus;
  metadata?: Metadata;
  multitask_strategy?: MultitaskStrategy | null;
  /** Execution payload, stored opaquely for the run engine (see {@link RunKwargs}). */
  kwargs?: RunKwargs;
}

/**
 * Filter + pagination for `GET /threads/{id}/runs`. A superset of {@link Pagination} so an existing
 * caller passing only `limit`/`offset` is unaffected.
 */
export interface RunListQuery extends Pagination {
  /**
   * Keep only runs in this status — the SDK's `runs.list({ status })`, which skein previously accepted
   * and ignored. Applied by the driver rather than by the caller, because filtering a page *after*
   * reading it makes `limit`/`offset` describe the unfiltered set: page 2 of "the failed runs" would
   * silently skip successful ones it never returned.
   */
  status?: RunStatus;
}

export interface RunRepo {
  get(runId: string): Promise<Run | null>;
  listByThread(threadId: string, query?: RunListQuery): Promise<Run[]>;
  create(input: RunCreate): Promise<Run>;
  /**
   * Create a run **only if** its thread has no inflight run, atomically — returning `null` when the
   * thread is busy. This is `multitask_strategy: "reject"`'s guard.
   *
   * Atomic is the whole point, and it is why this is a driver method rather than a
   * check-then-{@link create} in the service. That pair reads and writes with an `await` in between, so
   * two concurrent requests can both see an idle thread and both insert. An in-process mutex closes
   * that window for one process only — with two instances behind a load balancer, both win the race
   * and two runs interleave their checkpoint writes on one thread.
   *
   * A driver must therefore make the check and the insert indivisible against *other connections*, not
   * merely against other callers in its own process. Note it cannot be a unique index on
   * `(thread_id) WHERE inflight`: `enqueue` deliberately creates a second pending run on a busy thread,
   * so more than one inflight run per thread is legal — only the `reject` path forbids it.
   */
  createIfThreadIdle(input: RunCreate): Promise<Run | null>;
  /**
   * Move a run to `status`, recording why it got there when the transition is a failure. The run's
   * stored `error` is rewritten on *every* call, so omitting it clears any previously stored one —
   * a run row's `error` always describes its current status, never a stale earlier one.
   *
   * Status and error are set together deliberately: the run engine's `finalizeRun` re-reads the row
   * and then makes exactly one guarded write, so whichever of {engine finishes, cancel/timeout
   * fires} lands first wins. Splitting the error into a second write would reopen a window where a
   * run reads as `error` with no explanation, or where a racing cancel takes the status while the
   * error lands on top of it.
   */
  setStatus(runId: string, status: RunStatus, error?: RunError): Promise<Run>;
  delete(runId: string): Promise<void>;
  /** The opaque execution payload stored with a run, or null if the run is unknown. */
  getKwargs(runId: string): Promise<RunKwargs | null>;
  /**
   * Record {@link RunKwargs.base_checkpoint_id} for a run that is starting to execute, leaving the rest
   * of its kwargs untouched.
   *
   * A targeted patch rather than a kwargs rewrite: the caller has the id and nothing else, and
   * re-writing the whole blob would clobber concurrent changes and pay to re-serialize a run's entire
   * input. A no-op for an unknown run — the run may have been deleted mid-start, which is not an error
   * on a best-effort bookkeeping write.
   */
  recordBaseCheckpoint(runId: string, baseCheckpointId: string | null): Promise<void>;
  /**
   * The protocol concurrency guard: true while the thread has an *inflight* run — one still
   * `pending` or `running` (i.e. non-terminal per {@link isTerminalRunStatus}). An `interrupted`
   * run is terminal and does NOT count: it has yielded the thread to a human, and a resume arrives
   * as a fresh run. The run engine uses this to reject/queue concurrent runs.
   */
  hasActiveRun(threadId: string): Promise<boolean>;
  /**
   * Inflight runs — those still `pending` or `running` (non-terminal per
   * {@link isTerminalRunStatus}), the same set {@link hasActiveRun} counts. The multitask engine
   * reads a single thread's to `interrupt`/`rollback` them when a second run arrives mid-run. Order is
   * unspecified.
   *
   * `threadId` omitted means **every** thread's inflight runs, which is what `POST /runs/cancel`
   * (`cancelMany` with only a status filter) needs. That form is bounded by the driver's
   * `maxPageSize`, like every other unbounded read; the caller is expected to notice a full page and
   * say so rather than report a truncated sweep as a complete one.
   */
  listActiveRuns(threadId?: string): Promise<Run[]>;
  /**
   * The thread's most recently created run, or `null` for a thread that has never run.
   *
   * A driver method rather than a `listByThread(...)` the caller sorts, because the callers want *one*
   * row and the read is on the thread state path — `loadThreadGraph` resolves a thread's graph from its
   * latest run on every state, history, and state-update request. Reading the whole run history to use
   * its newest row means a driver returns every run of the thread (with its `kwargs` on Postgres) to
   * serve one, and it is the shape that kept `listByThread` on the "still unbounded" list.
   *
   * "Most recent" is `created_at` descending, **tie-broken on `run_id` descending** — the same
   * determinism contract {@link listByThread}'s ordering has, and it matters here because `created_at`
   * ties at millisecond resolution on a thread whose runs were created in one burst. Which row wins a
   * tie is arbitrary but must not vary between two calls on one driver.
   */
  latestForThread(threadId: string): Promise<Run | null>;
}

/**
 * Run statuses from which a run never transitions again. `"interrupted"` is terminal: resuming an
 * interrupt starts a *new* run on the same thread (this matches `@langchain/langgraph-api`, whose
 * inflight check is `pending | running` only — so an interrupted run never blocks the resume).
 */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "success",
  "error",
  "timeout",
  "interrupted",
  "cancelled",
];

/** True if `status` is terminal (the run is finished and no longer holds its thread). */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * The complement of {@link TERMINAL_RUN_STATUSES} — a run in one of these is *inflight* and holds its
 * thread.
 *
 * Stated positively as well as negatively because a SQL driver needs it that way. Postgres will only use
 * a partial index when it can prove the query's restriction implies the index predicate, and it cannot
 * prove that of `NOT (status = ANY($1))` — enumerating a column's domain is not something
 * `predicate_implied_by` does, and with a generic plan the parameter is not even a constant. Filtering
 * *positively* on this list matches an `IN (…)` predicate directly.
 */
export const INFLIGHT_RUN_STATUSES: readonly RunStatus[] = ["pending", "running"];

/**
 * Every run status as a *value*, for checking a string (a `?status=` query param) against the union.
 *
 * Derived from a `Record<RunStatus, true>` rather than written as an array so the compiler enforces
 * exhaustiveness: widening `RunStatus` fails this declaration instead of silently leaving the new
 * status unrecognized by every filter that validates against this list.
 */
export const RUN_STATUSES: readonly RunStatus[] = Object.keys({
  pending: true,
  running: true,
  success: true,
  error: true,
  timeout: true,
  interrupted: true,
  cancelled: true,
} satisfies Record<RunStatus, true>) as RunStatus[];

/**
 * Rows a `search` returns when the caller does not ask for a limit.
 *
 * "No limit" used to mean *every* row, which for threads meant every thread's full mirrored graph
 * state — a single `POST /threads/search` with an empty body could pull an entire table into the
 * heap. An absent limit now means the first page, which is what a caller almost always wanted.
 *
 * Matches the cap the request schemas already enforce on an explicit `limit`, so the implicit and
 * explicit ceilings agree. Drivers take it as an option so a deployment can lower it; both drivers
 * apply it, and the shared conformance suite holds them to that.
 */
export const DEFAULT_MAX_PAGE_SIZE = 1000;

/**
 * Validate a driver's `maxPageSize`, returning it. Every driver runs its option through this, so the
 * invariant holds wherever the value enters — the environment path validates too, but an embedder can
 * pass a literal.
 *
 * Both failure directions are silent without a guard, which is why this exists rather than a comment:
 * a non-positive or `NaN` bound makes the memory driver's `slice` return nothing, so **every list and
 * search comes back empty** with no error; and a value past `Number.MAX_SAFE_INTEGER` reaches `pg` as
 * exponential notation (`1e+21`), so every query fails with an `invalid input syntax for type bigint`
 * — after a clean boot.
 */
export function requireValidMaxPageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      `maxPageSize must be a positive integer no larger than ${Number.MAX_SAFE_INTEGER} (got ${value}).`,
    );
  }
  return value;
}

// --- store (long-term memory) -------------------------------------------------------------

export interface StoreSearchQuery {
  /** Restrict to items under this namespace prefix. */
  prefix?: string[];
  /** Natural-language query for semantic search (naive scan in the memory driver). */
  query?: string;
  limit?: number;
  offset?: number;
}

/**
 * Expiry policy for long-term store items (from `langgraph.json` `store.ttl`). All durations are in
 * minutes. A driver applies `defaultTtl` when a `put` gives no explicit `ttl`, refreshes an item's
 * expiry on read when `refreshOnRead` is set, and a background sweeper (interval `sweepIntervalMinutes`)
 * deletes expired rows via {@link StoreRepo.sweepExpired}.
 */
export interface StoreTtlConfig {
  /** Default item lifetime in minutes when `put` doesn't pass its own `ttl`. */
  defaultTtl?: number;
  /** Extend an item's expiry when it is read. Defaults to true. */
  refreshOnRead?: boolean;
  /** Sweeper cadence in minutes. Defaults to 60. */
  sweepIntervalMinutes?: number;
}

/** Per-`put` options. `ttl` (minutes) overrides the configured `defaultTtl` for this item. */
export interface StorePutOptions {
  ttl?: number;
}

export interface StoreRepo {
  get(namespace: string[], key: string): Promise<Item | null>;
  put(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    options?: StorePutOptions,
  ): Promise<Item>;
  delete(namespace: string[], key: string): Promise<void>;
  search(query: StoreSearchQuery): Promise<SearchItem[]>;
  listNamespaces(prefix?: string[], pagination?: Pagination): Promise<string[][]>;
  /** Delete every expired item; returns how many were removed. No-op when TTL is unconfigured. */
  sweepExpired(): Promise<number>;
}

// --- crons --------------------------------------------------------------------------------

/**
 * The principal a cron's fired runs execute as, stored beside the cron row and never on the wire.
 *
 * A cron fires with no HTTP request behind it, so there is no caller to authenticate at fire time.
 * The creating principal is captured once and replayed into every run's {@link RunKwargs.auth_user}
 * and {@link RunKwargs.auth_scopes}, so a cron created by user A keeps producing runs owned by A.
 *
 * Separate from the wire {@link Cron} for the same reason {@link RunKwargs} is separate from
 * {@link Run}: `Cron.payload` is echoed to any reader of `GET /runs/crons/{cron_id}`, and a
 * principal's permission scopes are not a thing to echo. Read only by the instance that already won
 * the claim — see {@link CronRepo.getAuth}.
 *
 * Ownership *filters* are deliberately NOT stored here. They are re-derived at fire time from the
 * user's own `@auth.on` handler, so a revoked principal's cron stops producing runs and a changed
 * handler is never shadowed by a frozen copy.
 */
export interface CronAuth {
  user: AuthUser;
  scopes?: string[];
}

/** Fields accepted when creating a cron. Every server-owned value is computed by the cron service. */
export interface CronCreate {
  assistant_id: string;
  /** A standard 5-field cron expression. Validated by the service; the driver stores it verbatim. */
  schedule: string;
  /** Server-assigned when omitted. */
  cron_id?: string;
  /** Absent/null means a *stateless* cron: every fire gets a fresh thread. */
  thread_id?: string | null;
  /** IANA zone the schedule is read in; absent/null means UTC, matching the SDK. */
  timezone?: string | null;
  end_time?: string | null;
  /**
   * When this cron next fires, or `null` when it never will again (disabled, or no occurrence left
   * before `end_time`).
   *
   * Computed by the cron service and stored verbatim — a driver must never derive it. Deriving it
   * needs a cron parser, and `@skein-js/core` has no runtime dependencies while a storage driver has
   * no business knowing cron syntax.
   */
  next_run_date?: string | null;
  /** Defaults to true. */
  enabled?: boolean;
  /**
   * What to do with a *stateless* cron's per-fire thread. Resolved by the service at create time
   * (`"delete"` for a stateless cron, absent for a thread cron) and persisted, so the wire row always
   * says what will actually happen — the same "resolve the decision, persist the answer" rule
   * {@link RunKwargs.delete_thread_on_completion} follows.
   */
  on_run_completed?: "delete" | "keep";
  /** The validated run-create body each fire replays. Stored verbatim and returned on the wire. */
  payload?: Record<string, unknown>;
  metadata?: Metadata;
  /** The creating principal's `identity` — the wire `Cron.user_id`. */
  user_id?: string | null;
  /** The principal a fired run executes as. Never on the wire — see {@link CronAuth}. */
  auth?: CronAuth;
}

/** Partial update; an omitted field is left unchanged, an explicit `null` clears a nullable one. */
export interface CronUpdate {
  schedule?: string;
  /** Tri-state: omitted leaves it, `null` clears it (back to UTC), a string sets it. */
  timezone?: string | null;
  /** Tri-state: omitted leaves it, `null` clears the end date, a string sets it. */
  end_time?: string | null;
  /**
   * Server-owned: the cron service recomputes it whenever a patch can change it (`schedule`,
   * `timezone`, `enabled`, or `end_time`). Without that, re-enabling a paused cron would leave it
   * dormant forever.
   */
  next_run_date?: string | null;
  enabled?: boolean;
  on_run_completed?: "delete" | "keep";
  payload?: Record<string, unknown>;
  /** MERGES (shallow) into the stored metadata, matching {@link AssistantRepo.update} and LangGraph. */
  metadata?: Metadata;
}

/**
 * What a cron listing may be sorted by — the SDK's {@link CronSortBy} plus `end_time`.
 *
 * Wider than the SDK on purpose: the LangSmith Deployment OpenAPI spec's `sort_by` enum includes
 * `end_time` while the SDK's TypeScript union does not, and the two are the same server. Accepting
 * the union of both means a client written against either gets the sort it asked for, rather than a
 * silent fall back to `created_at` that looks like the server ignoring it.
 */
export type CronSortKey = CronSortBy | "end_time";

/** Filter + pagination for `POST /runs/crons/search`. Omitted fields don't constrain the result. */
export interface CronSearchQuery {
  assistant_id?: string;
  thread_id?: string;
  enabled?: boolean;
  /** Match crons whose metadata contains every one of these key/value pairs (subset match). */
  metadata?: Metadata;
  /** The server's own scoping, AND-ed with `metadata` — see {@link ThreadSearchQuery.enforcedMetadata}. */
  enforcedMetadata?: Metadata;
  limit?: number;
  offset?: number;
  /** Sort key; defaults to `created_at`. */
  sortBy?: CronSortKey;
  /** Sort direction; defaults to `desc`. */
  sortOrder?: "asc" | "desc";
}

/** What a due-cron scan asks for. */
export interface DueCronsQuery {
  /**
   * Only crons whose `next_run_date` is at or before this instant. Passed in rather than read from
   * the driver's clock, so the scheduler's injected clock is the single source of "now" and a test
   * can freeze it.
   */
  dueAt: string;
  /** Max rows to return. The driver bounds it by `maxPageSize` regardless. */
  limit?: number;
}

/**
 * A due cron, paired with the claim token to bid for it with.
 *
 * The token is deliberately not a field of {@link Cron}: it is not wire state, no client has any use
 * for it, and `GET /runs/crons/{cron_id}` must not start returning scheduler bookkeeping. Handing it
 * back separately from the one read that needs it also keeps the compare-and-swap visible in the
 * scheduler, rather than hidden in a field that looks like data.
 */
export interface DueCron {
  cron: Cron;
  /** Pass back as {@link CronClaim.expectedSeq} to claim this occurrence. */
  occurrenceSeq: number;
}

/**
 * The compare-and-swap one instance uses to claim a single occurrence of a cron.
 *
 * The token is `occurrence_seq`, an integer the driver bumps on **every** write, rather than the
 * `next_run_date` it is advancing. A timestamp would work in principle and fail in practice: a
 * `timestamptz` carries microseconds, which are truncated on the way back out through a millisecond
 * `Date`, so a comparison could stop matching and **no cron would ever fire again with nothing
 * logged to say so**. An integer also closes the ABA window where a `PATCH` recomputes back to the
 * same instant between the scan and the claim.
 */
export interface CronClaim {
  /** The `occurrence_seq` the claimer read. The claim lands only if the row still holds exactly this. */
  expectedSeq: number;
  /** Where to advance `next_run_date` to; `null` when the cron has no occurrence left. */
  nextRunDate: string | null;
}

/** A won claim: the advanced cron row, and the `pending` run committed alongside it. */
export interface ClaimedCronRun {
  cron: Cron;
  run: Run;
}

export interface CronRepo {
  get(cronId: string): Promise<Cron | null>;
  /** Filtered + paginated listing backing `POST /runs/crons/search`. */
  search(query: CronSearchQuery): Promise<Cron[]>;
  /**
   * Number of crons matching `query` (ignoring limit/offset), backing `POST /runs/crons/count`.
   * Counted independently of {@link search} for the same reason {@link ThreadRepo.count} is.
   */
  count(query: CronSearchQuery): Promise<number>;
  create(input: CronCreate): Promise<Cron>;
  /** Throws when the cron is unknown. */
  update(cronId: string, patch: CronUpdate): Promise<Cron>;
  delete(cronId: string): Promise<void>;
  /**
   * Enabled crons whose `next_run_date` has arrived, soonest first — the scheduler's tick read.
   *
   * Scanning and claiming are two calls rather than one atomic statement, and that is a constraint
   * rather than a preference: advancing a cron means computing its *next occurrence*, which needs a
   * cron parser. A parser cannot live in `@skein-js/core` (zero runtime dependencies, a hard
   * invariant) and does not belong in a storage driver, which has no business knowing cron syntax.
   * So the scan happens here and the advance happens under a compare-and-swap, which is what makes
   * the pair race-free without a lock.
   *
   * Deliberately NOT ownership-filtered, for the same reason {@link RunRepo.listActiveRuns} is not:
   * this is scheduler machinery, not a user-facing read. A filtered version would hide a cron from
   * the very loop that has to fire it.
   *
   * Soonest-first ordering matters when the scan is truncated: the oldest occurrence always wins a
   * slot, so a backlog drains in order instead of starving.
   */
  listDue(query: DueCronsQuery): Promise<DueCron[]>;
  /**
   * Fire one occurrence: advance `next_run_date` **and** create the run, atomically, but only if the
   * cron still holds `expectedSeq` and is still enabled. Returns `null` for every loser — a peer that
   * claimed first, a cron disabled or deleted in between, or a stale scan.
   *
   * This is what replaces a leader election or a distributed lock. Every instance ticks, every
   * instance may see the same due cron, and exactly one wins a single-row conditional UPDATE on a
   * primary key — no lock ordering, no deadlock surface, no isolation-level dependency, no Redis.
   *
   * **The two writes must commit together.** That is what makes the run row a transactional outbox:
   * advancing without the run would silently skip the occurrence if the instance died in between
   * (at-most-once), and creating the run first would re-fire it. Committed together, the worst case
   * is a `pending` run that was never enqueued — which the scheduler's sweep re-enqueues, and which
   * is the same window every background run already has. Delivery is therefore at-least-once, and
   * execution exactly-once, because enqueue is idempotent and the worker skips runs already terminal.
   */
  claimAndCreateRun(
    cronId: string,
    claim: CronClaim,
    run: RunCreate,
  ): Promise<ClaimedCronRun | null>;
  /**
   * Advance `next_run_date` without firing — the exhausted-cron path, where the occurrence that came
   * due is past `end_time` so there is nothing to run and `nextRunDate` is `null`. Same
   * compare-and-swap contract as {@link claimAndCreateRun}, minus the run.
   */
  claimNextRun(cronId: string, claim: CronClaim): Promise<Cron | null>;
  /**
   * The principal a fired run executes as, or `null` when the cron is unknown or had no caller.
   *
   * A separate read, like {@link RunRepo.getKwargs}, so the wire row stays free of it and the
   * due-scan pays nothing: only the instance that *won* the claim reads it.
   */
  getAuth(cronId: string): Promise<CronAuth | null>;
  /**
   * How overdue the most overdue enabled cron is, in milliseconds at `now`, or `null` when nothing is
   * due — the scheduler's liveness gauge.
   *
   * A dedicated read because it is the one signal that distinguishes "no crons are due" from "the
   * ticker is dead": healthy, it stays under one tick; with a stopped scheduler it climbs without
   * bound. Derived in the driver rather than from a {@link listDue} page so a truncated scan cannot
   * under-report it.
   */
  maxOverdueMs(now: string): Promise<number | null>;
}

/** Offset pagination shared by collection repositories. HTTP callers must always set a limit. */
export interface Pagination {
  limit?: number;
  offset?: number;
}

// --- idempotency --------------------------------------------------------------------------

/**
 * The verbatim wire response an idempotent replay reproduces.
 *
 * A *response*, not a domain object: the point of a replay is that the retrying caller cannot tell
 * it from the original, which means the status code and the headers are as load-bearing as the body.
 */
export interface RecordedResponse {
  status: number;
  body: unknown;
  /**
   * The headers worth replaying — `content-location` above all.
   *
   * It is what the SDK parses to fire `onRunCreated`, which is how `useStream` learns the run id it
   * stores to rejoin the stream after a remount. A replay that drops it leaves the client with a run
   * it cannot find again, and nothing fails loudly enough to notice.
   */
  headers?: Record<string, string>;
}

/**
 * A create recorded against an `Idempotency-Key`, so a provider's retry gets the same answer instead
 * of a second run.
 *
 * Every webhook provider retries — Twilio on timeout or 5xx, Stripe, GitHub, Slack. Without a record
 * here, a retry means a second reply to the end user or two agents acting on one event, and the
 * failure is silent.
 */
export interface IdempotencyRecord {
  /** The caller's `Idempotency-Key` header, verbatim. Opaque to skein — never parsed, only compared. */
  key: string;
  /**
   * What the key is scoped to — `"{METHOD} {path} {principal}"`.
   *
   * The principal is not decoration. Without it, one tenant guessing another's key would replay that
   * tenant's recorded response, which names a run and a thread they have no other way to see. Scoping
   * by method and path as well keeps a key reused across two endpoints from colliding, which callers
   * do more often than they admit.
   */
  scope: string;
  /**
   * Hex SHA-256 of the canonicalized request, so the same key sent with a *different* body is
   * refused rather than silently answered with the first request's response.
   */
  fingerprint: string;
  /**
   * The token the claiming request holds. {@link IdempotencyRepo.record} and
   * {@link IdempotencyRepo.release} are both conditional on it, so a claim that expired and was taken
   * over by a retry cannot have the original's response written on top of it.
   */
  claim_id: string;
  status: IdempotencyStatus;
  /** Present only once `status` is `"done"`. */
  response?: RecordedResponse;
  /** The run this key created, for correlating a replay with the run it refers to. */
  run_id?: string;
  /**
   * The thread the recorded run belongs to, so deleting that thread can take this record with it.
   *
   * Present whenever the response named exactly one thread — which is every single-run create.
   * `POST /runs/batch` leaves it absent: its runs may span threads, and its body is a list of run
   * rows rather than conversation content, so there is nothing thread-shaped to erase.
   */
  thread_id?: string;
  created_at: string;
  updated_at: string;
  /**
   * When this record stops being replayable.
   *
   * Set short at claim time (long enough that an in-flight `POST /runs/wait` is never stolen from
   * under itself) and rewritten to the full retention when the response is recorded — so one column
   * and one rule cover both "the claiming instance died" and "the dedup window is over".
   *
   * An expired row is *taken over* by the next claim rather than waiting to be swept, so correctness
   * never depends on the sweeper having run. The sweep only reclaims space.
   */
  expires_at: string;
}

/**
 * `"in_flight"` — a request holds the key and has not finished. `"done"` — a response is recorded and
 * replayable. There is deliberately no `"failed"`: see {@link IdempotencyRepo.release}.
 */
export type IdempotencyStatus = "in_flight" | "done";

/** The claim a request stakes on a key before executing. */
export interface IdempotencyClaim {
  key: string;
  scope: string;
  fingerprint: string;
  /** The claim token to store, so {@link IdempotencyRepo.record} can prove it still owns the key. */
  claim_id: string;
  /**
   * Now, as the caller sees it — what an incumbent's `expires_at` is compared against.
   *
   * Supplied rather than read from the database clock, matching {@link ThreadRepo.listExpired} and
   * {@link CronRepo.maxOverdueMs}. Both sides of the comparison then come from the same place: the
   * expiry being tested was itself written by an application instance. Letting the driver substitute
   * its own clock would mean a pod running behind the database wrote claims that were already expired,
   * and every one of them would be taken over immediately — starting the duplicate run this resource
   * exists to prevent, on a deployment where nothing looks wrong.
   */
  now: string;
  /** Absolute expiry for the in-flight window, computed by the caller from its configured retention. */
  expires_at: string;
}

/** The outcome of {@link IdempotencyRepo.claim} — who owns the key, and what is already recorded. */
export interface IdempotencyClaimResult {
  /** True when this call inserted the row, or took over an expired one. The caller owns the request. */
  claimed: boolean;
  /** The row as it now stands: this caller's on a win, the incumbent's on a loss. */
  record: IdempotencyRecord;
}

/** The response to attach to a claimed key, plus the retention that replaces the in-flight window. */
export interface RecordedResponseInput extends RecordedResponse {
  /** Extends the record's `expires_at` from the short in-flight window to the full retention. */
  expires_at: string;
  run_id?: string;
  thread_id?: string;
}

/**
 * Recorded responses keyed on `(scope, key)` — the storage behind the `Idempotency-Key` header.
 *
 * Only creates are recorded. Reads are already idempotent, and recording them would spend a row per
 * request to guarantee something HTTP guarantees for free.
 */
export interface IdempotencyRepo {
  /**
   * Claim `key` for this request, or report the claim that already holds it.
   *
   * **Insert first and let the `(scope, key)` uniqueness constraint arbitrate — never read, then
   * write.** The window between a read and a write is precisely the burst this defends against: two
   * provider retries landing on two instances within milliseconds. This is the discipline
   * {@link RunRepo.createIfThreadIdle} and {@link CronRepo.claimAndCreateRun} already follow, and the
   * shared conformance suite holds every driver to it with a concurrent-claim case.
   *
   * An **expired** incumbent is taken over in the same statement rather than reported as a loss, so a
   * claimant that crashed mid-request frees its key without a sweep having run and without the
   * retrying caller paying a second round trip. Taking over resets the row: a stale response from the
   * dead claim must never be replayed against the new one's fingerprint.
   */
  claim(claim: IdempotencyClaim): Promise<IdempotencyClaimResult>;
  /**
   * Attach the response, mark the record `"done"`, and extend `expires_at` to the full retention.
   *
   * A **no-op, not a throw**, when `claimId` no longer matches: the claim expired and another request
   * owns the key now, and overwriting its record would answer *its* caller with this request's
   * response. Losing the write is the safe direction — the caller still returns its own response, and
   * only the recording is lost.
   */
  record(
    scope: string,
    key: string,
    claimId: string,
    recorded: RecordedResponseInput,
  ): Promise<void>;
  /**
   * Drop a claim whose request failed, so the next retry executes for real. Conditional on `claimId`
   * exactly as {@link record} is.
   *
   * **Failures are deliberately never recorded.** Pinning a transient 503 for the whole retention
   * would make a momentary outage permanent for that key: every retry for the next 24 hours would
   * replay the failure instead of trying again, which is the opposite of what a retrying caller
   * wants and impossible to diagnose from the outside.
   */
  release(scope: string, key: string, claimId: string): Promise<void>;
  get(scope: string, key: string): Promise<IdempotencyRecord | null>;
  /**
   * Delete every record whose recorded run belonged to `threadId`; returns how many were removed.
   *
   * **This is erasure, not housekeeping.** A recorded response has to outlive its run for a replay to
   * mean anything, and for `POST /runs/wait` that response *is* the graph's final state — so without
   * this, deleting a thread would leave a full copy of the conversation in a table no API surfaces,
   * for the whole retention window. Anyone who reads `DELETE /threads/{thread_id}` as "erase this"
   * would be wrong, and nothing would say so.
   *
   * Deliberately **not** driven by a foreign key. The cascade would also fire for a stateless run's
   * server-created thread, which is deleted the moment that run completes (`on_completion: "delete"`)
   * — destroying the record microseconds after writing it and breaking idempotency for exactly the
   * "an external service drives skein and retries" case the header exists for. Which deletions count
   * as erasure is a decision for the service layer, and it makes it by calling this.
   */
  deleteByThread(threadId: string): Promise<number>;
  /**
   * Delete every record past `expires_at`; returns how many were removed.
   *
   * Space reclamation only — {@link claim} already takes over an expired row, so a deployment whose
   * sweeper never ran is slower, not wrong. Mirrors {@link StoreRepo.sweepExpired}.
   */
  sweepExpired(): Promise<number>;
}

// --- the store ----------------------------------------------------------------------------

/** The single persistence seam for Agent Protocol resources. One implementation per driver. */
export interface SkeinStore {
  assistants: AssistantRepo;
  threads: ThreadRepo;
  runs: RunRepo;
  crons: CronRepo;
  store: StoreRepo;
  idempotency: IdempotencyRepo;
  /**
   * Whether rows written here survive a process restart.
   *
   * Only crons consult it, and only to warn: every other resource is created by a caller who finds
   * out it is gone the next time they look, whereas a *schedule* is expected to keep firing while
   * nobody is watching. A memory-backed cron in a long-lived server is silently erased by every
   * deploy, and a schedule that quietly stops is worse than one that was never created — so the
   * scheduler says so once at startup rather than letting it be discovered later.
   *
   * Optional so an existing third-party driver still satisfies the interface; absent is read as
   * "unknown", which does not warn. Both bundled drivers set it.
   */
  readonly durable?: boolean;
  /**
   * The page bound this driver applies to an unbounded read (see {@link DEFAULT_MAX_PAGE_SIZE}).
   *
   * Exposed so a caller can tell a *complete* result from a truncated one. Without it the only way to
   * ask "was there more?" is a second, wider read — and for the whole-server sweep behind
   * `POST /runs/cancel` that read cannot be ownership-scoped, so its result must never reach a client.
   * Publishing the bound answers the question from the read the caller already did.
   *
   * Optional so an existing third-party driver still satisfies the interface; a caller that needs it
   * must handle its absence. Both bundled drivers provide it.
   */
  readonly maxPageSize?: number;
}

/**
 * A driver-agnostic, JSON-serializable snapshot of every resource row — the unit of bulk
 * transfer for persistence and migration tooling (e.g. `skein dev`'s cross-restart snapshot, and
 * importing an existing LangGraph in-memory dev state). Each entry is an `[id, row]` tuple: the id
 * is the entity's own id, except `items` (keyed by `JSON.stringify([namespace, key])`),
 * `runKwargs` (keyed by `run_id`, since {@link RunKwargs} has no id of its own), and
 * `assistantVersions` (keyed by `JSON.stringify([assistant_id, version])`).
 *
 * A driver MAY expose `restore(snapshot)` to bulk-load one of these verbatim — ids and timestamps
 * preserved — which is what makes an import lossless. It is intentionally not part of
 * {@link SkeinStore}: only migration tooling needs it, and consumers feature-detect it.
 */
export interface SkeinStoreSnapshot {
  assistants: [string, Assistant][];
  assistantVersions: [string, AssistantVersion][];
  threads: [string, Thread][];
  runs: [string, Run][];
  runKwargs: [string, RunKwargs][];
  items: [string, Item][];
  /**
   * Optional so a snapshot written by an older skein still loads — the same tolerance
   * `assistantVersions` gets. This is also what gives `skein dev` cron persistence across restarts
   * for free, since its autosave is one of these.
   *
   * A restore inserts crons *after* threads (a thread cron references one) and skips any cron whose
   * thread is not part of the import, exactly as it does for runs. {@link CronAuth} is deliberately
   * absent: it is not wire state, and a snapshot is a transfer format that gets written to disk.
   */
  crons?: [string, Cron][];
  // Idempotency records are deliberately absent. A dedup window is per-deployment ephemera, not
  // resource state: carrying `in_flight` rows across a `skein dev` reload would make the first retry
  // after a restart 409 against a claim whose request died with the old process, and carrying `done`
  // rows would replay a response naming runs the reloaded store no longer has.
}
