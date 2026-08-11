// Threads: the conversation container runs execute against, plus the mirrored graph state a client
// reads without asking the checkpointer.

import type { DefaultValues, Interrupt, Metadata, Thread, ThreadStatus } from "../wire/wire.js";

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
