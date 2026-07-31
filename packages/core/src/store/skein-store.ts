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

export interface ThreadCreate {
  /** Server-assigned when omitted. */
  thread_id?: string;
  metadata?: Metadata;
  status?: ThreadStatus;
}

/** Partial update; omitted fields are left unchanged. */
export interface ThreadUpdate {
  metadata?: Metadata;
  status?: ThreadStatus;
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
  create(input?: ThreadCreate): Promise<Thread>;
  update(threadId: string, patch: ThreadUpdate): Promise<Thread>;
  /** Duplicate a thread's row (new id, fresh timestamps); checkpoint history is copied at the service layer. */
  copy(threadId: string): Promise<Thread>;
  delete(threadId: string): Promise<void>;
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

/** Offset pagination shared by collection repositories. HTTP callers must always set a limit. */
export interface Pagination {
  limit?: number;
  offset?: number;
}

// --- the store ----------------------------------------------------------------------------

/** The single persistence seam for Agent Protocol resources. One implementation per driver. */
export interface SkeinStore {
  assistants: AssistantRepo;
  threads: ThreadRepo;
  runs: RunRepo;
  store: StoreRepo;
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
}
