// Cron expression math — the only file in skein-js that knows cron syntax, and the only one that
// imports a cron library. Everything else deals in "here is the next ISO instant, or null".
//
// Kept to one small module on purpose: the scheduler, the service and both storage drivers all treat
// `next_run_date` as an opaque value skein computed, so swapping the library is a one-file change.
//
// Deliberately NOT in `@skein-js/core`: core has zero runtime dependencies, and a storage driver has
// no business knowing cron syntax either. That constraint is what makes the scheduler's scan and
// claim two calls rather than one atomic statement — see `CronRepo.listDue`.

import { SkeinHttpError } from "@skein-js/core";
import { Cron as CronExpression } from "croner";

/** How many whitespace-separated fields a standard cron expression has. */
const CRON_FIELD_COUNT = 5;

/** What to compute the next occurrence of. */
export interface CronOccurrenceQuery {
  /** A standard 5-field cron expression. */
  schedule: string;
  /** IANA zone the expression is read in; absent/null means UTC, matching the SDK. */
  timezone?: string | null;
  /** Exclusive lower bound — the answer is the first occurrence strictly after this instant. */
  after: Date;
  /** No occurrence at or before this instant counts; absent/null means the cron runs forever. */
  endTime?: string | null;
}

/**
 * Reject anything that is not a standard 5-field expression in a real IANA zone, as a 422.
 *
 * The field count is checked here rather than left to croner, which is deliberately more permissive
 * than standard cron: it also accepts 6-field (seconds-first) expressions, `@daily`-style nicknames,
 * and `L`/`?`. LangGraph Platform answers *"cron must be a standard 5-field expression"*, and a
 * drop-in replacement that silently accepted `0 0 9 * * *` would run it at a different time than the
 * author reading their own crontab expects — a wrong schedule is worse than a rejected one.
 *
 * Within five fields, croner's own validator decides. The timezone is validated by *using* it: an
 * unknown zone throws from `Intl`, and only on evaluation rather than construction.
 */
export function assertValidCronSchedule(schedule: string, timezone?: string | null): void {
  const fields = schedule.trim().split(/\s+/);
  if (schedule.trim().length === 0 || fields.length !== CRON_FIELD_COUNT) {
    throw SkeinHttpError.unprocessable(
      `cron must be a standard 5-field expression; got ${fields.length} field(s) in "${schedule}".`,
    );
  }
  try {
    // Evaluated, not merely constructed: croner defers both expression semantics and timezone
    // resolution to the first `nextRun`, so constructing alone would accept a zone that never works.
    new CronExpression(schedule, { timezone: timezone ?? "UTC" }).nextRun();
  } catch (error) {
    throw SkeinHttpError.unprocessable(
      `Invalid cron schedule "${schedule}"${timezone ? ` in timezone "${timezone}"` : ""}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The first occurrence strictly after `after`, as an ISO string — or `null` when there is none,
 * which is what makes a cron *dormant*.
 *
 * `null` covers three cases that the rest of the system treats identically: the expression is
 * unreachable (`0 0 30 2 *` — February 30th), the next occurrence would fall past `end_time`, or
 * `end_time` has already passed.
 *
 * Assumes the schedule has already been through {@link assertValidCronSchedule}, which the service
 * does at create and patch time. A stored schedule cannot become invalid afterwards.
 */
export function nextCronOccurrence(query: CronOccurrenceQuery): string | null {
  const next = new CronExpression(query.schedule, {
    timezone: query.timezone ?? "UTC",
  }).nextRun(query.after);
  if (next === null) return null;
  // Compared explicitly rather than handed to croner's own `stopAt`, so the boundary semantics are
  // ours and do not shift under a library option's edge behaviour. An occurrence falling exactly on
  // `end_time` still fires — the end is inclusive, matching "run until then".
  if (query.endTime != null && next.getTime() > Date.parse(query.endTime)) return null;
  return next.toISOString();
}

/**
 * Where a cron that just came due should point next: the first occurrence strictly after
 * *whichever is later* of the occurrence it is leaving and now.
 *
 * The `later of` is the whole point, and getting it wrong is the bug this function exists to
 * prevent. Advancing from the stored date alone moves a five-minutely cron that is an hour behind
 * forward by five minutes — still in the past — so it comes due again on the very next tick and the
 * outage replays as a burst of backfilled runs, drip-fed. Taking the later of the two collapses
 * every missed occurrence into the single catch-up fire, which is what APScheduler's `coalesce` and
 * BullMQ's own repeat strategy both do.
 *
 * Using `max` rather than plain `now` matters in the other direction: an instance whose clock runs
 * behind its peers would otherwise compute a "next" they already consider past, and the two would
 * hand the occurrence back and forth.
 */
export function advanceCronOccurrence(
  query: Omit<CronOccurrenceQuery, "after"> & { from: string; now: Date },
): string | null {
  const from = Date.parse(query.from);
  const after = new Date(Math.max(Number.isNaN(from) ? 0 : from, query.now.getTime()));
  return nextCronOccurrence({ ...query, after });
}
