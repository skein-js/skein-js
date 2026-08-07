// The two retention knobs, in their own module so `deps.ts` can carry the config without importing
// the handler wrapper (which imports `deps.ts` back for `Clock`/`Logger`).

/** How long a claim is held before another request may take it over, and how long a record replays. */
export interface IdempotencyConfig {
  /**
   * How long a recorded response stays replayable, in hours. Default 24 — long enough to cover any
   * provider's retry schedule, short enough that the table does not grow without bound.
   */
  retentionHours?: number;
  /**
   * How long an unfinished claim blocks a retry, in minutes. Default 15.
   *
   * Above any realistic run timeout, so an in-flight `POST /runs/wait` is never stolen from under
   * itself and answered twice; short enough that a SIGKILLed instance's keys free themselves within
   * the shift rather than 409-ing until the retention expires.
   */
  inFlightMinutes?: number;
  /**
   * How often the background sweeper reclaims expired records, in minutes. Default 60.
   *
   * Carried here, alongside the retention it sweeps, exactly as `ThreadTtlConfig` carries its own
   * cadence — so one config block reaches the runtime and the loop reads what it needs from it.
   */
  sweepIntervalMinutes?: number;
}
