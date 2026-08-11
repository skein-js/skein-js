// Recorded responses for the `Idempotency-Key` header, so a provider's retry of a create gets the
// original answer instead of a second run.

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
   * Delete the record holding `runId`'s recorded response; returns how many were removed.
   *
   * The narrower counterpart to {@link deleteByThread}, for `DELETE /threads/{id}/runs/{run_id}`.
   * Without it, erasing a single run leaves its output — for `POST /runs/wait`, the graph's final
   * state — behind in this table, which is the same hole deleting a whole thread would have.
   */
  deleteByRun(runId: string): Promise<number>;
  /**
   * Delete every record whose `expires_at` is at or before `now`; returns how many were removed.
   *
   * Takes `now` for the same reason {@link claim} does, and it is not merely cosmetic here: the
   * driver's own clock running ahead of the application's would delete records that {@link claim}
   * still considers replayable, so a retry inside the advertised window would find nothing and start
   * a second run. One clock decides expiry, and it is the caller's.
   *
   * Otherwise space reclamation only — {@link claim} takes over an expired row itself, so a
   * deployment whose sweeper never ran is slower, not wrong.
   */
  sweepExpired(now: string): Promise<number>;
}
