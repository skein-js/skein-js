// How outbound run-completion deliveries are retried, bounded and (in PR 3) signed — the engine's
// camelCase view of `langgraph.json`'s `skein.webhooks` block.
//
// Absence means **defaults, not off**, in the register `IdempotencyConfig` uses: a caller who passed a
// `webhook` has been promised a callback, and how hard we try to deliver it is a tuning decision
// rather than an on/off switch. `max_attempts: 1` is how you ask for today's fire-once behaviour.

/** Retry policy for a delivery that could not be handed to its receiver. */
export interface DeliveryRetryConfig {
  /**
   * How many attempts a delivery gets before it is `dead`, counting the engine's inline first one.
   *
   * **Read this as a time horizon, not a count.** At the default `initialDelayMs` the delays double,
   * so 12 attempts is 1+2+4+…+1024 ≈ **34 minutes** of trying — enough to sit out a rolling deploy
   * or a short receiver outage with room to spare, which is what this is for. Halving it to 6 is not
   * "half as patient": it is ~31 seconds, which does not survive a single redeploy.
   */
  maxAttempts?: number;
  /**
   * The first retry's delay, and the base the rest double from. Defaults to 1000.
   *
   * There is deliberately **no ceiling knob**. At any sane attempt count the doubling tops out well
   * inside an hour (12 attempts reaches ~17 minutes), so a ceiling would be a public option that
   * never fires — and on Redis, honouring one would mean replacing BullMQ's built-in exponential
   * backoff with a hand-written strategy to gain nothing. If a deployment ever raises `maxAttempts`
   * far enough for the tail to matter, that is the moment to add it.
   */
  initialDelayMs?: number;
}

export interface WebhookDeliveryConfig {
  retries?: DeliveryRetryConfig;
  /**
   * The cap on a stored delivery body, in bytes. Defaults to 256 KiB.
   *
   * A delivery's payload is stored rather than re-rendered, so an unbounded one is unbounded rows in
   * the database. Over the cap, `values` is replaced by a truncation marker **inside the body**, so a
   * receiver is told it is looking at a truncated state rather than left to infer it.
   */
  maxPayloadBytes?: number;
  /** How long a terminal delivery is kept before the sweep reclaims it, in hours. Defaults to 24. */
  retainHours?: number;
  /**
   * Hostnames a delivery may be sent to. Absent means no restriction, which is today's behaviour.
   *
   * The `webhook` URL is caller-supplied, so it is a server-side request to a target the caller chose
   * — and retrying it turns a one-shot SSRF probe into a repeated one. A deployment that accepts
   * untrusted run creates should set this. It is **not** on by default: every existing deployment
   * would start dropping its own callbacks on upgrade.
   *
   * A delivery to a host not on the list is recorded `dead` with the reason rather than silently
   * skipped, so it is visible in the delivery list instead of being a callback that never arrives.
   */
  allowedHosts?: readonly string[];
  /**
   * The keys callbacks are signed with. Signing is off when this is empty.
   *
   * A **list**, because rotation has to be possible without dropping deliveries. Signing uses the
   * first; a receiver is told to accept any it has been given. Rotate by prepending the new key,
   * waiting out the receivers, then removing the old one — remove it first and every callback is
   * refused until the last receiver has caught up.
   *
   * Never read from `langgraph.json`'s own `secret` field alone: see `resolveWebhooks`, and note that
   * skein does not expand `${VAR}` in that file, so `"secret": "${SKEIN_WEBHOOK_SECRET}"` would sign
   * with the literal 25-character string — the worst possible outcome for a signing key.
   */
  secrets?: readonly string[];
}

export const DEFAULT_MAX_ATTEMPTS = 12;
export const DEFAULT_INITIAL_DELAY_MS = 1_000;
export const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
export const DEFAULT_RETAIN_HOURS = 24;

/**
 * Headroom added to a claim's lease, on top of the time the batch could actually take.
 *
 * A lease has to outlive **every POST in the batch it covers**, not one of them — the polling worker
 * attempts its claim sequentially, so with the default batch of 20 and the default 5s timeout the
 * last row is not touched for 100 seconds. A flat minute would expire under rows 13 onward, and a
 * peer would re-claim and re-POST them: duplicate callbacks, and an attempt budget spent twice as
 * fast as configured. {@link deliveryLeaseMs} sizes it from the batch; this is the margin on top.
 *
 * Erring long is cheap — it only delays takeover after a genuine crash. Erring short duplicates
 * callbacks in normal operation.
 */
export const DELIVERY_LEASE_MARGIN_MS = 60_000;

/**
 * How long a claimer holds a batch of deliveries before a peer may take them over: long enough for
 * every POST in it, plus {@link DELIVERY_LEASE_MARGIN_MS}.
 */
export function deliveryLeaseMs(batchSize: number, perAttemptMs: number): number {
  return Math.max(1, batchSize) * Math.max(1, perAttemptMs) + DELIVERY_LEASE_MARGIN_MS;
}

/** How often the delivery worker looks for due deliveries. */
export const DEFAULT_DELIVERY_POLL_INTERVAL_MS = 5_000;

/** Deliveries claimed per tick, so one tick is a bounded unit of work. */
export const DEFAULT_DELIVERY_BATCH_SIZE = 20;

/**
 * How long past its due time a queue-scheduled delivery is left alone before the recovery sweep
 * treats its job as lost.
 *
 * A **margin, not a hiding place.** The sweep re-schedules what it finds, and scheduling is
 * idempotent on the delivery id, so a sweep that overlaps a job the queue is merely holding costs
 * nothing — which is exactly why this can be a minute rather than the whole remaining schedule. It is
 * only large enough that the sweep does not race the queue on every ordinary retry.
 *
 * This is what makes a lost enqueue recoverable within a sweep interval instead of within hours. It
 * is safe only because the sweep reads with {@link DeliveryRepo.listDue} rather than claiming: a
 * claiming sweep would spend the attempt budget of every delivery it looked at.
 */
export const QUEUE_SWEEP_MARGIN_MS = 60_000;

/**
 * How many attempts are left for a queue to make, given how many have already happened.
 *
 * Shared by the hand-off after the inline attempt and by the recovery sweep, because the sweep
 * getting this wrong is silent: a `schedule` with no attempt budget gets BullMQ's default of one, so
 * a recovered delivery would go `dead` on its next failure instead of finishing the schedule its
 * configuration promised.
 */
export function remainingQueueAttempts(attempt: number, retries?: DeliveryRetryConfig): number {
  return Math.max(1, (retries?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) - attempt);
}

/**
 * Poll cadence for the recovery sweep when a queue owns the schedule.
 *
 * Rare on purpose: with a queue, a due row is evidence of a *lost job*, which happens only when a
 * process died between the outbox COMMIT and the enqueue. Polling every few seconds for that would
 * be a query per instance per tick to catch something that happens on a crash.
 */
export const DEFAULT_SWEEP_POLL_INTERVAL_MS = 300_000;
