// Crons: schedules that fire runs with no HTTP request behind them. The claim is a compare-and-swap
// on an integer token, which is what replaces a leader election across instances.

import type { AuthUser } from "../auth/auth.js";
import type { Cron, CronSortBy, Metadata, Run } from "../wire/wire.js";

import type { RunCreate } from "./runs.js";

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
