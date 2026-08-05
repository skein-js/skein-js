// The thread TTL sweeper: the loop that collects threads whose lifetime has run out.
//
// It lives here, beside the cron scheduler, rather than with `startStoreTtlSweeper` in
// `@skein-js/runtime` — and that placement is the whole design. A store item is a row, so its sweep is
// a `DELETE`. A thread is a *container*: it owns runs that may still be executing and a checkpoint
// history in the saver, so collecting one has to go through the thread service, which aborts the
// in-flight run and closes its event bus before the rows disappear. A driver-level `DELETE` would
// leave a run writing into a thread that no longer exists.
//
// The driver picks *which* threads are due (an indexed read of `expires_at`); the service performs the
// deletion. Neither half can do the other's job.

import type { Logger } from "../deps.js";

import type { ThreadService } from "./thread-service.js";

/** Default cadence, matching `store.ttl`'s sweeper. */
const DEFAULT_SWEEP_INTERVAL_MINUTES = 60;

/**
 * Threads collected per tick. Bounded so one sweep is a bounded unit of work: each deletion aborts
 * runs and prunes checkpoints, which is far more expensive than deleting a store item. A backlog
 * drains over several ticks rather than in one long transaction — and the tick re-runs immediately
 * when it fills the batch, so draining does not wait out the interval.
 */
const SWEEP_BATCH_SIZE = 100;

export interface ThreadTtlSweeperDeps {
  store: {
    threads: { listExpired(query: { now: string; limit: number }): Promise<string[]> };
    /** The driver's own page bound, which caps a batch below {@link SWEEP_BATCH_SIZE}. */
    maxPageSize?: number;
  };
  threads: Pick<ThreadService, "delete">;
  logger: Logger;
  /** Injected so tests can drive time; defaults to the wall clock. */
  clock?: () => Date;
}

export interface ThreadTtlSweeperOptions {
  /** Cadence in minutes. Defaults to 60. */
  sweepIntervalMinutes?: number;
}

export interface ThreadTtlSweeper {
  /** Run one sweep and report how many threads it collected. Exposed for tests and for `/ok`-style probes. */
  sweepOnce(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

export function createThreadTtlSweeper(
  deps: ThreadTtlSweeperDeps,
  options: ThreadTtlSweeperOptions = {},
): ThreadTtlSweeper {
  const clock = deps.clock ?? ((): Date => new Date());
  const everyMs = (options.sweepIntervalMinutes ?? DEFAULT_SWEEP_INTERVAL_MINUTES) * 60_000;

  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  /**
   * How many ids one scan can actually return: the batch size, bounded by the driver's own page cap.
   *
   * Both, and the smaller wins — the same reasoning as the cron scheduler's `scanLimit`. A deployment
   * with `SKEIN_MAX_PAGE_SIZE` below the batch size can never fill a batch, so comparing against
   * `SWEEP_BATCH_SIZE` alone would mean a backlog never looks full and drains one page per *interval*
   * instead of re-ticking immediately — hours of latency at the default hourly cadence.
   */
  const scanLimit = Math.min(SWEEP_BATCH_SIZE, deps.store.maxPageSize ?? SWEEP_BATCH_SIZE);

  /** One scan: what it found, and how much of it was actually collected. */
  const sweepBatch = async (): Promise<{ listed: number; collected: number }> => {
    const expired = await deps.store.threads.listExpired({
      now: clock().toISOString(),
      limit: scanLimit,
    });
    let collected = 0;
    for (const threadId of expired) {
      try {
        await deps.threads.delete(threadId);
        collected += 1;
      } catch (error) {
        // One thread failing must not abandon the rest of the batch — it would block every thread
        // behind it forever, since the sweep reads oldest-expiry-first and this one stays at the head.
        // A thread deleted by someone else between the read and here is the common case and harmless.
        deps.logger.warn(`thread ${threadId}: TTL sweep could not delete it; continuing.`, error);
      }
    }
    if (collected > 0) deps.logger.info(`thread TTL sweep collected ${collected} thread(s).`);
    return { listed: expired.length, collected };
  };

  const sweepOnce = async (): Promise<number> => (await sweepBatch()).collected;

  /**
   * The loop. Like the cron scheduler's, its single most important property is that it always
   * schedules the next tick: the reschedule is in a `finally` and the catch never rethrows, so no
   * failure mode silently ends sweeping for the life of the process.
   */
  const loop = async (): Promise<void> => {
    let full = false;
    try {
      // On what the scan *listed*, not what it collected. A batch where a few deletes threw is still
      // a full batch — more is due — and treating it as a short one would park the backlog for a
      // whole interval on account of the failures.
      full = (await sweepBatch()).listed >= scanLimit;
    } catch (error) {
      deps.logger.error("thread TTL sweep failed; the sweeper continues.", error);
    } finally {
      if (running) {
        // A full batch means more was due than one scan can return, so drain immediately rather than
        // leaving the backlog to trickle out one batch per hour.
        timer = setTimeout(runLoop, full ? 0 : everyMs);
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
