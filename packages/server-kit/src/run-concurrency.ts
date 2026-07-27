// How many queued runs one instance's background worker executes at once — the single place skein
// resolves that number. The CLI (`--concurrency` / `-n`), every framework adapter
// (`worker.maxConcurrency`), and the environment (`SKEIN_RUN_CONCURRENCY`, or the
// LangGraph-compatible `N_JOBS_PER_WORKER`) all funnel through here, so the surfaces can't disagree.
// Mirrors `postgresConnectionOptions()` in @skein-js/runtime: an explicit value wins, but the
// environment is still read *and validated*, so a typo in a deployment's environment fails loudly at
// boot instead of being silently ignored.

import { DEFAULT_RUN_CONCURRENCY } from "@skein-js/agent-protocol";

import { positiveIntegerFromEnv, requirePositiveInteger } from "./env-numbers.js";

/** Canonical env var first, then the LangGraph CLI spelling we also accept. */
const CONCURRENCY_ENV_VARS = ["SKEIN_RUN_CONCURRENCY", "N_JOBS_PER_WORKER"] as const;

/**
 * The one precedence chain for background-run concurrency: an explicit value (a `worker.maxConcurrency`
 * option, or the CLI's `--concurrency` / `-n`) wins, else `SKEIN_RUN_CONCURRENCY`, else
 * `N_JOBS_PER_WORKER`, else {@link DEFAULT_RUN_CONCURRENCY}. The environment is read and validated
 * even when `explicit` is given, so a bad `SKEIN_RUN_CONCURRENCY` can't sit unnoticed in a deployment
 * that also passes the option.
 *
 * `env` is injected (defaulting to `process.env`) so callers — and tests — can resolve against an
 * environment they control.
 */
export function resolveRunConcurrency(
  explicit?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fromEnv = positiveIntegerFromEnv(CONCURRENCY_ENV_VARS, env);
  if (explicit === undefined) return fromEnv ?? DEFAULT_RUN_CONCURRENCY;
  return requirePositiveInteger("worker.maxConcurrency", explicit);
}
