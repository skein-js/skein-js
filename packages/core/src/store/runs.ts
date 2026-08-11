// Runs: one execution of a graph against a thread, its opaque execution payload, and the status
// vocabulary every driver and filter shares.

import type { AuthUser } from "../auth/auth.js";
import type { RunError } from "../errors/run-error.js";
import type {
  Config,
  Metadata,
  MultitaskStrategy,
  Run,
  RunStatus,
  StreamMode,
} from "../wire/wire.js";

import type { FinalizedRun, RunFinalization } from "./deliveries.js";
import type { Pagination } from "./pagination.js";

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
  /**
   * Move a run to `status` **only if it is not already terminal**, and record `final.delivery` — both
   * in one atomic write. Returns the effective run (`null` when the row no longer exists) and the
   * delivery that was created, whose {@link Delivery.run_status} is the status the transaction
   * actually committed.
   *
   * **The two halves have opposite conditions, on purpose.** The status write is conditional because a
   * cancel may already have won — {@link setStatus} is what `cancelRun` uses, deliberately racing the
   * engine and beating it. The delivery insert is *unconditional*, because the engine owns the
   * notification either way: that is what it does today, and making the insert conditional too would
   * open a window where a cancel that beats the engine notifies nobody at all.
   *
   * **The two writes must commit together.** That is what makes this a transactional outbox, in exactly
   * the sense {@link CronRepo.claimAndCreateRun} is one. Writing the status alone loses the
   * notification if the instance dies before the insert — today's bug, which no injected dispatcher can
   * close, because the window sits *before* any caller-supplied code runs. Inserting first would
   * announce a completion that never committed. Committed together, the worst case is a leased delivery
   * whose worker died, which the next {@link DeliveryRepo.claimDue} takes over.
   *
   * The delivery is inserted **even when the run row is gone** (deleted mid-run), because the engine
   * still notifies in that case. That is also why a driver must not put a foreign key on
   * {@link Delivery.run_id} — see {@link Delivery}.
   *
   * Optional so an existing third-party driver still satisfies the interface, like
   * {@link SkeinStore.durable}. A driver that omits it — or a store with no {@link SkeinStore.deliveries}
   * — gets the pre-outbox behaviour: a read-checked {@link setStatus} and one best-effort POST.
   */
  finalizeWithDelivery?(runId: string, final: RunFinalization): Promise<FinalizedRun>;
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
