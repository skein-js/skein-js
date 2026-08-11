// The outbox for run-completion webhooks: a delivery recorded in the same transaction as the run's
// terminal status, so the news that a run finished is as durable as the run.

import type { RunError } from "../errors/run-error.js";
import type { Run, RunStatus } from "../wire/wire.js";

import type { Pagination } from "./pagination.js";

/**
 * Where an outbound delivery is in its lifecycle. `delivered` and `dead` are terminal; a `dead` row
 * keeps its payload so a replay can actually resend it.
 */
export type DeliveryStatus = "pending" | "delivering" | "delivered" | "dead";

/**
 * One outbound run-completion callback, recorded in the *same transaction* as the run's terminal
 * status so a crash between "the run finished" and "someone was told" cannot lose it.
 *
 * **The payload is stored, not re-rendered at send time**, and that is not a trade-off between space
 * and freshness — re-rendering is unimplementable for the case that matters most. A stateless
 * `POST /runs` deletes the thread the server created for it as soon as the run settles, which in
 * Postgres cascades the run row away, so a retry an hour later has neither a run row nor a checkpoint
 * to render from. That path is exactly the "an external service drives skein and gets the answer
 * back" case this exists for, so re-rendering would make the flagship case the one that cannot retry.
 *
 * For the same reason there is deliberately **no foreign key** on {@link run_id} or
 * {@link thread_id}: the rows they name may be gone well before the last attempt. This is the
 * argument {@link IdempotencyRepo.deleteByThread} already makes about cascades, reached from the
 * other direction.
 */
export interface Delivery {
  delivery_id: string;
  /** The run this reports on. NOT a foreign key — the run may be deleted before the last attempt. */
  run_id: string;
  /** Carried so a delivery stays attributable, and ownership-scopable, after its run is gone. */
  thread_id: string;
  /** The absolute `http(s)` target, as validated at run-create time. */
  url: string;
  /**
   * The body to send, minus its `status` field (see {@link run_status}). `null` once the delivery
   * succeeded — see {@link DeliveryRepo.recordAttempt}, which is what keeps steady-state storage
   * proportional to *in-flight* deliveries rather than to every delivery ever made.
   */
  payload: unknown;
  /** True when `values` was replaced by a truncation marker to fit the configured payload cap. */
  payload_truncated: boolean;
  /**
   * The run's **effective** terminal status at the instant this row was written — the status the
   * transaction actually committed, which is not always the one the caller asked for, because a
   * cancel may have won the race. Merged into the body at send time, so a callback can never disagree
   * with the run it describes.
   *
   * Also the only record of how the run ended once the run row itself has been deleted.
   */
  run_status: RunStatus;
  status: DeliveryStatus;
  /** Attempts started, counting from 1. Reported to the receiver so it can see a retry as a retry. */
  attempt: number;
  /**
   * When this delivery next becomes claimable.
   *
   * **It doubles as the lease deadline while `delivering`**, which is what lets a worker killed
   * mid-POST be recovered with no separate reclaim path: a `delivering` row whose lease has passed is
   * simply due again, and the next {@link DeliveryRepo.claimDue} takes it over. That is the same
   * mechanism by which {@link IdempotencyRepo.claim} takes over an expired claim rather than waiting
   * for a sweep.
   */
  next_attempt_at: string;
  /** Why the last attempt failed, or `null` while none has. */
  last_error: string | null;
  created_at: string;
  updated_at: string;
  /** When a *terminal* row may be reclaimed by {@link DeliveryRepo.sweepExpired}. */
  expires_at: string;
}

/**
 * A delivery to record alongside a run's terminal status.
 *
 * `run_id` and `run_status` are absent by design: the driver stamps both from the transaction it just
 * committed, so they cannot disagree with the row that was actually written.
 *
 * The created row is **already claimed** — `delivering`, `attempt: 1`, leased until
 * {@link next_attempt_at}. The run engine attempts the first delivery inline, exactly as it does
 * today, so a healthy receiver still hears within milliseconds rather than at the next worker tick.
 * If that process dies before it can report the outcome, the lease expires and a worker takes over.
 */
export interface DeliveryCreate {
  /** Server-assigned when omitted. Stable across every retry — the receiver's dedup key. */
  delivery_id?: string;
  thread_id: string;
  url: string;
  payload: unknown;
  /** Defaults to `false`. */
  payload_truncated?: boolean;
  /** The inline attempt's lease deadline: the caller's clock plus its lease. */
  next_attempt_at: string;
  expires_at: string;
}

/** What {@link RunRepo.finalizeWithDelivery} writes: the run's terminal status, and the delivery. */
export interface RunFinalization {
  status: RunStatus;
  error?: RunError;
  delivery: DeliveryCreate;
}

/** What {@link RunRepo.finalizeWithDelivery} wrote. `run` is `null` when the run row was gone. */
export interface FinalizedRun {
  run: Run | null;
  delivery: Delivery;
}

/** Filter + pagination for a run's deliveries. */
export interface DeliveryListQuery extends Pagination {
  status?: DeliveryStatus;
}

/** A worker's claim on due deliveries. */
export interface DueDeliveriesQuery {
  /** The application's clock. A row is due when its `next_attempt_at` is at or before this. */
  now: string;
  /** How long the claimer holds each row before a peer may take it over. */
  leaseUntil: string;
  limit?: number;
}

/**
 * How one attempt ended. A closed union rather than three methods: same behaviour, a third of the
 * permanent surface, and a driver cannot invent a fourth outcome.
 */
export type DeliveryAttemptResult =
  | { outcome: "delivered" }
  | { outcome: "retrying"; nextAttemptAt: string; error: string }
  | { outcome: "dead"; error: string };

/**
 * Outbound run-completion callbacks awaiting delivery — the transactional outbox behind the
 * `webhook` field on run creation.
 */
export interface DeliveryRepo {
  get(deliveryId: string): Promise<Delivery | null>;
  /**
   * A run's deliveries, newest first, **tie-broken on `delivery_id` descending** — the same
   * determinism contract {@link RunRepo.latestForThread} has, and it matters for the same reason: a
   * replayed delivery and its original tie at millisecond resolution. An absent `limit` returns one
   * page bounded by {@link SkeinStore.maxPageSize}.
   */
  listByRun(runId: string, query?: DeliveryListQuery): Promise<Delivery[]>;
  /**
   * Take ownership of up to `limit` deliveries due at `query.now`, atomically: each claimed row
   * becomes `delivering`, its `attempt` increments, and its `next_attempt_at` moves to
   * `query.leaseUntil`.
   *
   * **Atomic against other connections, not merely other callers in this process.** Every instance
   * runs a delivery worker, so a read-then-update pair would hand one row to two workers and
   * double-POST on every tick — with two instances behind a load balancer, an in-process mutex closes
   * nothing. This is {@link CronRepo.claimAndCreateRun}'s contract in a different shape, and the
   * shared conformance suite holds every driver to it.
   *
   * One predicate covers both due-ness and crash recovery: a `delivering` row whose lease has passed
   * is due again (see {@link Delivery.next_attempt_at}).
   *
   * Soonest-first, so a backlog drains in order rather than starving its oldest rows.
   */
  claimDue(query: DueDeliveriesQuery): Promise<Delivery[]>;
  /**
   * Record how the current attempt ended; `null` for an unknown delivery.
   *
   * `delivered` **clears the payload** — that is what makes steady-state storage (in-flight ×
   * payload cap) rather than (every delivery ever × payload cap), and it is why {@link retryNow}
   * refuses an already-delivered row. `retrying` stores the error and when to try again. `dead` keeps
   * the payload, so a replay has something to resend.
   *
   * Deliberately **not conditional on still holding the lease**. At-least-once is the documented
   * guarantee, the lease is sized well above the POST timeout, and the cost of losing that race is
   * one duplicate POST — which is exactly what the stable delivery id exists to let a receiver absorb.
   * A conditional write would trade that for the worse failure of a delivered row still looking due.
   */
  recordAttempt(deliveryId: string, result: DeliveryAttemptResult): Promise<Delivery | null>;
  /**
   * Make a delivery due again at `nextAttemptAt`, resetting it to `pending` — the operator's replay.
   *
   * Returns `null` when the delivery is unknown **or** its payload was cleared on delivery, so the
   * caller can say which rather than silently doing nothing.
   *
   * `nextAttemptAt` is the caller's, for the reason {@link IdempotencyRepo.sweepExpired} gives: one
   * clock decides when work is due, and it is the application's, not the database's.
   */
  retryNow(deliveryId: string, nextAttemptAt: string): Promise<Delivery | null>;
  /**
   * Delete terminal rows whose `expires_at` is at or before `now`; returns how many were removed.
   * Space reclamation only — nothing is incorrect in a deployment whose sweep never ran.
   */
  sweepExpired(now: string): Promise<number>;
}
