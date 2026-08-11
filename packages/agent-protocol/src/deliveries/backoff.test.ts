// The retry schedule, asserted as a **time horizon** rather than as a sequence of delays.
//
// A count of attempts is not something an operator can evaluate. "12 attempts" tells you nothing
// about whether a delivery survives a rolling deploy; "34 minutes" tells you immediately. So the load
// bearing assertion here is the sum, and the individual delays only matter insofar as they produce it.

import { describe, expect, it } from "vitest";

import { isFinalAttempt, nextAttemptDelayMs } from "./backoff.js";
import { DEFAULT_MAX_ATTEMPTS, remainingQueueAttempts } from "./delivery-config.js";

/** Total wait across every retry a delivery gets, with jitter pinned to its midpoint. */
function horizonMs(maxAttempts: number, initialDelayMs = 1_000): number {
  let total = 0;
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    // 0.5 draws the midpoint of the jitter window, i.e. 90% of the undithered delay.
    total += nextAttemptDelayMs(attempt, { maxAttempts, initialDelayMs }, () => 0.5);
  }
  return total;
}

describe("delivery backoff", () => {
  it("gives the default policy a horizon of roughly half an hour", () => {
    // 1+2+4+…+1024 seconds. The number in the docs and the config comment is this one; if the
    // defaults change, this fails and both have to be restated rather than quietly drifting.
    const minutes = horizonMs(DEFAULT_MAX_ATTEMPTS) / 60_000;
    expect(minutes).toBeGreaterThan(25);
    expect(minutes).toBeLessThan(40);
  });

  it("clears a one-minute receiver outage well inside the default attempts", () => {
    // The goal the whole outbox exists for: a receiver down for a minute still gets its callback.
    let elapsed = 0;
    let attempt = 1;
    while (elapsed < 60_000 && attempt < DEFAULT_MAX_ATTEMPTS) {
      elapsed += nextAttemptDelayMs(attempt, {}, () => 0.5);
      attempt += 1;
    }
    expect(elapsed).toBeGreaterThanOrEqual(60_000);
    // Reached with attempts to spare — the margin is the point, not the exact number.
    expect(attempt).toBeLessThan(DEFAULT_MAX_ATTEMPTS);
  });

  it("shows why a smaller attempt count is not a smaller version of the same policy", () => {
    // 6 attempts reads like "half as patient as 12". It is ~31 seconds against ~34 minutes: it does
    // not survive one redeploy. This case exists so that trade-off is visible rather than arithmetic
    // an operator has to do themselves.
    expect(horizonMs(6) / 1_000).toBeLessThan(35);
  });

  it("doubles from the initial delay, counting the inline attempt as the first", () => {
    const fixed = { initialDelayMs: 1_000 };
    // Attempt 1 already happened inline, so the *first* retry waits the initial delay, not twice it.
    // 90% of 1s / 2s / 16s — the jitter window's midpoint.
    expect(nextAttemptDelayMs(1, fixed, () => 0.5)).toBe(900);
    expect(nextAttemptDelayMs(2, fixed, () => 0.5)).toBe(1_800);
    expect(nextAttemptDelayMs(5, fixed, () => 0.5)).toBe(14_400);
  });

  it("keeps the longest default delay well inside an hour, which is why there is no ceiling knob", () => {
    // Stated as a test because the config comment claims it, and because it is the argument for a
    // public option we deliberately did not ship: a reader should not have to take it on prose.
    const largest = nextAttemptDelayMs(DEFAULT_MAX_ATTEMPTS - 1, {}, () => 0.99);
    expect(largest).toBeLessThan(3_600_000);
  });

  it("jitters either side of the delay, so a shared outage does not retry in lockstep", () => {
    const fixed = { initialDelayMs: 1_000 };
    // Without jitter, every delivery that failed against one receiver during one outage would come
    // back at exactly the same instant — a synchronized herd of precisely the requests that just
    // overwhelmed it.
    // The shape is BullMQ's: a uniform draw from [delay * (1 - jitter), delay). Matching it exactly
    // is what keeps one retry policy from meaning two different things across the two drivers.
    expect(nextAttemptDelayMs(1, fixed, () => 0)).toBe(800);
    expect(nextAttemptDelayMs(1, fixed, () => 0.999)).toBe(999);
  });

  it("never returns a negative delay", () => {
    expect(nextAttemptDelayMs(1, { initialDelayMs: 1 }, () => 0)).toBeGreaterThanOrEqual(0);
  });

  // Regression: `2 ** attempt` runs to `Infinity` well before the schema's only bound (`.positive()`)
  // stops you, and a caller turning that into `new Date(now + delay).toISOString()` gets a
  // `RangeError` — from a code path whose whole contract is that it does not throw.
  it("stays finite however many attempts are configured", () => {
    for (const attempt of [12, 43, 1_000, Number.MAX_SAFE_INTEGER]) {
      const delay = nextAttemptDelayMs(attempt, { maxAttempts: attempt });
      expect(Number.isFinite(delay)).toBe(true);
      expect(() => new Date(Date.now() + delay).toISOString()).not.toThrow();
    }
  });

  // Regression, and the reason `RedisDeliveryQueue` seeds BullMQ with twice the configured delay.
  // BullMQ computes `2^(attemptsMade - 1) * delay` counting only the attempts *it* made, but the
  // engine already made one inline — so its first retry is the schedule's *second* gap. Seeding it
  // raw halves every delay, turning a documented ~34-minute horizon into ~17 on Redis while the
  // polling driver still gives 34: one policy, two meanings.
  it("has a second gap of twice the initial delay, which is what BullMQ must be seeded with", () => {
    const fixed = { initialDelayMs: 1_000 };
    const midpoint = () => 0.5;

    // Gap 1 (inline attempt → first retry) is the configured delay; the queue is handed this as an
    // explicit `delayMs`, so BullMQ's own backoff never computes it.
    expect(nextAttemptDelayMs(1, fixed, midpoint)).toBe(900);
    // Gap 2 is the first one BullMQ computes, at `attemptsMade = 1` → `2^0 × seed`. For that to
    // equal this, the seed must be 2 × initial.
    expect(nextAttemptDelayMs(2, fixed, midpoint)).toBe(1_800);
    // And gap 3, at `attemptsMade = 2` → `2^1 × seed` = 4 × initial. Doubling holds from there.
    expect(nextAttemptDelayMs(3, fixed, midpoint)).toBe(3_600);
  });

  it("never offers a queue fewer than one attempt", () => {
    expect(remainingQueueAttempts(1, { maxAttempts: 12 })).toBe(11);
    // A policy lowered under a delivery already in flight must not produce a zero or negative budget.
    expect(remainingQueueAttempts(20, { maxAttempts: 12 })).toBe(1);
  });

  it("calls the last attempt final, and only the last", () => {
    expect(isFinalAttempt(11, { maxAttempts: 12 })).toBe(false);
    expect(isFinalAttempt(12, { maxAttempts: 12 })).toBe(true);
    // Past the bound too, so a policy lowered under a delivery already in flight still terminates.
    expect(isFinalAttempt(13, { maxAttempts: 12 })).toBe(true);
    // `max_attempts: 1` is how a deployment asks for the pre-outbox fire-once behaviour.
    expect(isFinalAttempt(1, { maxAttempts: 1 })).toBe(true);
  });
});
