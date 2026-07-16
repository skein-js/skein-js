// `SkeinStore` — the durable home for Agent Protocol *resources* (assistants, threads, runs,
// long-term store items). This is deliberately NOT LangGraph's checkpointer: graph state and
// history stay 100% LangGraph-native via a `BaseCheckpointSaver`. SkeinStore owns only the
// resource rows that OSS keeps in memory (see docs/storage.md).
//
// Every driver (memory, postgres, …) implements this one interface and is held to the shared
// conformance suite, so they behave identically. Methods return the wire types from
// `../wire`, so a handler can pass a repo result straight to the client.

import type { AuthUser } from "../auth/auth.js";
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
}

/** Filter + pagination for `POST /threads/search`. Omitted fields don't constrain the result. */
export interface ThreadSearchQuery {
  /** Match threads whose metadata contains every one of these key/value pairs (subset match). */
  metadata?: Metadata;
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

export interface RunRepo {
  get(runId: string): Promise<Run | null>;
  listByThread(threadId: string): Promise<Run[]>;
  create(input: RunCreate): Promise<Run>;
  setStatus(runId: string, status: RunStatus): Promise<Run>;
  delete(runId: string): Promise<void>;
  /** The opaque execution payload stored with a run, or null if the run is unknown. */
  getKwargs(runId: string): Promise<RunKwargs | null>;
  /**
   * The protocol concurrency guard: true while the thread has an *inflight* run — one still
   * `pending` or `running` (i.e. non-terminal per {@link isTerminalRunStatus}). An `interrupted`
   * run is terminal and does NOT count: it has yielded the thread to a human, and a resume arrives
   * as a fresh run. The run engine uses this to reject/queue concurrent runs.
   */
  hasActiveRun(threadId: string): Promise<boolean>;
  /**
   * The thread's *inflight* runs — those still `pending` or `running` (non-terminal per
   * {@link isTerminalRunStatus}), the same set {@link hasActiveRun} counts. The multitask engine
   * reads these to `interrupt`/`rollback` them when a second run arrives mid-run. Order is
   * unspecified.
   */
  listActiveRuns(threadId: string): Promise<Run[]>;
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
  listNamespaces(prefix?: string[]): Promise<string[][]>;
  /** Delete every expired item; returns how many were removed. No-op when TTL is unconfigured. */
  sweepExpired(): Promise<number>;
}

// --- the store ----------------------------------------------------------------------------

/** The single persistence seam for Agent Protocol resources. One implementation per driver. */
export interface SkeinStore {
  assistants: AssistantRepo;
  threads: ThreadRepo;
  runs: RunRepo;
  store: StoreRepo;
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
