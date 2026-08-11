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
}

export const DEFAULT_MAX_ATTEMPTS = 12;
export const DEFAULT_INITIAL_DELAY_MS = 1_000;
export const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
export const DEFAULT_RETAIN_HOURS = 24;

/**
 * How long a claimer holds a delivery before a peer may take it over.
 *
 * A constant rather than a knob: the only thing it has to clear is one POST, and the POST already has
 * its own bound (`DEFAULT_WEBHOOK_TIMEOUT_MS`, 5s, raisable via `SKEIN_WEBHOOK_TIMEOUT_MS`). A minute
 * leaves an order of magnitude of headroom, and the cost of getting it wrong in the tight direction is
 * one duplicate POST — which at-least-once already permits and the delivery id already absorbs.
 */
export const DELIVERY_LEASE_MS = 60_000;

/** How often the delivery worker looks for due deliveries. */
export const DEFAULT_DELIVERY_POLL_INTERVAL_MS = 5_000;

/** Deliveries claimed per tick, so one tick is a bounded unit of work. */
export const DEFAULT_DELIVERY_BATCH_SIZE = 20;

/**
 * How long a delivery is invisible to the recovery sweep once a queue has taken charge of it.
 *
 * When a `DeliveryQueue` owns the schedule, the row's `next_attempt_at` stops meaning "try again at"
 * and starts meaning "assume the job is lost after". So it is set to the whole remaining schedule,
 * doubled: being too generous costs a lost job sitting a while longer, while being too tight has the
 * sweep re-attempting a delivery the queue is merely holding — collapsing the backoff it is applying.
 */
export function queueSweepGraceMs(retries?: DeliveryRetryConfig): number {
  const initial = retries?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const attempts = retries?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  return initial * 2 ** attempts * 2;
}

/**
 * Poll cadence for the recovery sweep when a queue owns the schedule.
 *
 * Rare on purpose: with a queue, a due row is evidence of a *lost job*, which happens only when a
 * process died between the outbox COMMIT and the enqueue. Polling every few seconds for that would
 * be a query per instance per tick to catch something that happens on a crash.
 */
export const DEFAULT_SWEEP_POLL_INTERVAL_MS = 300_000;
