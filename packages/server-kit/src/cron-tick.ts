// How often each instance looks for due crons — the single place skein resolves that number, so the
// four framework adapters and `skein dev`/`start` cannot disagree. Mirrors `resolveRunConcurrency`:
// an explicit value wins, but the environment is still read *and validated*, so a typo in a
// deployment's environment fails loudly at boot instead of being silently ignored.

import { DEFAULT_CRON_TICK_MS } from "@skein-js/agent-protocol";

import { positiveIntegerFromEnv, requirePositiveInteger } from "./env-numbers.js";

/**
 * No LangGraph-compatible spelling to also accept here: LangGraph Platform runs the scheduler for
 * you and exposes no knob for it, so this is skein's own.
 */
const CRON_TICK_ENV_VARS = ["SKEIN_CRON_TICK_MS"] as const;

/**
 * The one precedence chain for the cron tick interval: an explicit `scheduler.tickMs` wins, else
 * `SKEIN_CRON_TICK_MS`, else {@link DEFAULT_CRON_TICK_MS}. The environment is read and validated even
 * when `explicit` is given, so a bad value cannot sit unnoticed in a deployment that also passes the
 * option.
 *
 * Lowering this does not make schedules more accurate below one minute — a 5-field cron expression
 * cannot express anything finer. Raising it trades lateness for fewer reads; the practical ceiling is
 * one minute, past which a `* * * * *` cron visibly skips minutes.
 *
 * `env` is injected (defaulting to `process.env`) so callers — and tests — can resolve against an
 * environment they control.
 */
export function resolveCronTickMs(explicit?: number, env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = positiveIntegerFromEnv(CRON_TICK_ENV_VARS, env);
  if (explicit === undefined) return fromEnv ?? DEFAULT_CRON_TICK_MS;
  return requirePositiveInteger("scheduler.tickMs", explicit);
}
