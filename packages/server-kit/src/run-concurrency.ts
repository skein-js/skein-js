// How many queued runs one instance's background worker executes at once — the single place skein
// resolves that number. The CLI (`--concurrency` / `-n`), every framework adapter
// (`worker.maxConcurrency`), and the environment (`SKEIN_RUN_CONCURRENCY`, or the
// LangGraph-compatible `N_JOBS_PER_WORKER`) all funnel through here, so the surfaces can't disagree.
// Mirrors `postgresConnectionOptions()` in @skein-js/runtime: an explicit value wins, but the
// environment is still read *and validated*, so a typo in a deployment's environment fails loudly at
// boot instead of being silently ignored.

import { DEFAULT_RUN_CONCURRENCY } from "@skein-js/agent-protocol";
import { SkeinConfigError } from "@skein-js/config";

/** Canonical env var first, then the LangGraph CLI spelling we also accept. */
const CONCURRENCY_ENV_VARS = ["SKEIN_RUN_CONCURRENCY", "N_JOBS_PER_WORKER"] as const;

function requirePositiveInteger(source: string, raw: string | number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SkeinConfigError(`${source} must be a positive integer (got "${String(raw)}").`);
  }
  return parsed;
}

/** The declared concurrency, or undefined when neither variable is set (or both are blank). */
function runConcurrencyFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  for (const name of CONCURRENCY_ENV_VARS) {
    const raw = env[name];
    // Blank counts as unset — `Number("")` is 0, which would otherwise throw a confusing
    // "must be a positive integer (got "")" for a variable the user effectively left empty.
    if (raw === undefined || raw.trim() === "") continue;
    return requirePositiveInteger(name, raw);
  }
  return undefined;
}

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
  const fromEnv = runConcurrencyFromEnv(env);
  if (explicit === undefined) return fromEnv ?? DEFAULT_RUN_CONCURRENCY;
  return requirePositiveInteger("worker.maxConcurrency", explicit);
}
