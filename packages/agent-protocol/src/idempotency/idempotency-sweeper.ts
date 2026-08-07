// The idempotency sweeper: the loop that reclaims recorded responses past their retention.
//
// Unlike the thread TTL sweeper beside it, **correctness does not depend on this loop running.**
// `IdempotencyRepo.claim` takes over an expired record in the statement that claims it, so a
// deployment whose sweeper never ticked answers every request correctly — it just carries rows it
// no longer needs. That is why this drives a single driver-side `DELETE` rather than the thread
// sweeper's read-then-delete-each: there is no container to tear down, only space to reclaim, and
// both drivers already batch the delete internally.

import type { SkeinStore } from "@skein-js/core";

import type { Logger } from "../deps.js";

/** Default cadence, matching `store.ttl`'s sweeper and the thread TTL sweeper. */
const DEFAULT_SWEEP_INTERVAL_MINUTES = 60;

export interface IdempotencySweeperDeps {
  store: Pick<SkeinStore, "idempotency">;
  logger: Logger;
  /** Injected so tests can drive time; defaults to the wall clock. Matches the thread TTL sweeper. */
  clock?: () => Date;
}

export interface IdempotencySweeperOptions {
  /** Cadence in minutes. Defaults to 60. */
  sweepIntervalMinutes?: number;
}

export interface IdempotencySweeper {
  /** Run one sweep and report how many records it removed. Exposed for tests and probes. */
  sweepOnce(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

export function createIdempotencySweeper(
  deps: IdempotencySweeperDeps,
  options: IdempotencySweeperOptions = {},
): IdempotencySweeper {
  const clock = deps.clock ?? ((): Date => new Date());
  const everyMs = (options.sweepIntervalMinutes ?? DEFAULT_SWEEP_INTERVAL_MINUTES) * 60_000;

  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const sweepOnce = async (): Promise<number> => {
    // The application's clock decides expiry, matching `IdempotencyRepo.claim` — a driver sweeping on
    // its own clock could delete records a claim still treats as replayable.
    const removed = await deps.store.idempotency.sweepExpired(clock().toISOString());
    if (removed > 0) deps.logger.info(`idempotency sweep removed ${removed} record(s).`);
    return removed;
  };

  /**
   * The loop. Like the thread sweeper's, its single most important property is that it always
   * schedules the next tick: the reschedule is in a `finally` and the catch never rethrows, so no
   * failure mode silently ends sweeping for the life of the process.
   */
  const loop = async (): Promise<void> => {
    try {
      await sweepOnce();
    } catch (error) {
      deps.logger.error("idempotency sweep failed; the sweeper continues.", error);
    } finally {
      if (running) {
        timer = setTimeout(runLoop, everyMs);
        timer.unref?.();
      }
    }
  };

  const runLoop = (): void => {
    inFlight = loop();
  };

  return {
    sweepOnce,

    start() {
      if (running) return;
      running = true;
      timer = setTimeout(runLoop, everyMs);
      timer.unref?.();
    },

    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      // Wait out a sweep already in flight, so `stop()` resolving means nothing is still deleting.
      // It cannot reject — `loop` swallows its own failures — so this needs no catch.
      await inFlight;
      inFlight = undefined;
    },
  };
}
