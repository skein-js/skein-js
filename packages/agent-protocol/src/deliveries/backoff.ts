// When to try a failed delivery again.

import {
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_MAX_ATTEMPTS,
  type DeliveryRetryConfig,
} from "./delivery-config.js";

/**
 * How much of the computed delay is randomized away.
 *
 * The shape — a uniform draw from `[delay * (1 - jitter), delay)` — is copied from BullMQ's built-in
 * exponential strategy on purpose. This function is the **development** driver's schedule; on Redis
 * the schedule is BullMQ's own, and a policy that meant two different things depending on which
 * queue you deployed would be worse than no policy.
 */
const JITTER_FRACTION = 0.2;

/** The ceiling any single delay is clamped to. Internal, not a config knob — see the note below. */
const MAX_ATTEMPT_DELAY_MS = 24 * 3_600_000;

/**
 * How long to wait after `attempt` failed, before the next one.
 *
 * Exponential, clamped, then jittered. The jitter is the part that matters at scale and is easy to
 * leave out: without it, every delivery that failed against one receiver during one outage retries in
 * lockstep forever after, so the receiver comes back up into a synchronized thundering herd of exactly
 * the requests that just overwhelmed it.
 *
 * `random` is injected so a test can pin the jitter; it defaults to `Math.random`.
 */
export function nextAttemptDelayMs(
  attempt: number,
  retries: DeliveryRetryConfig = {},
  random: () => number = Math.random,
): number {
  const initial = retries.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  // `attempt` counts from 1, so the first retry waits `initial` rather than twice it.
  //
  // Clamped, and not for tidiness: the schema bounds `max_attempts` only by `.positive()`, so a few
  // dozen attempts sends `2 ** attempt` past `Number.MAX_SAFE_INTEGER` and on to `Infinity` — and a
  // caller turning that into `new Date(now + delay).toISOString()` gets a `RangeError` from a path
  // whose contract is that it does not throw. A day is longer than any real schedule needs.
  const ceiling = Math.min(
    Math.round(initial * 2 ** Math.max(0, attempt - 1)),
    MAX_ATTEMPT_DELAY_MS,
  );
  const floor = ceiling * (1 - JITTER_FRACTION);
  return Math.floor(random() * ceiling * JITTER_FRACTION + floor);
}

/** True when `attempt` was the last one this delivery gets, so a failure now is terminal. */
export function isFinalAttempt(attempt: number, retries: DeliveryRetryConfig = {}): boolean {
  return attempt >= (retries.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
}
