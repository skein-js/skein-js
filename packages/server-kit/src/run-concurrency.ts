// How many queued runs one instance's background worker executes at once — the single place skein
// resolves that number. The CLI (`--concurrency` / `-n`), every framework adapter
// (`worker.maxConcurrency`), and the environment (`SKEIN_RUN_CONCURRENCY`, or the
// LangGraph-compatible `N_JOBS_PER_WORKER`) all funnel through here, so the surfaces can't disagree.
// Mirrors `postgresConnectionOptions()` in @skein-js/runtime: an explicit value wins, but the
// environment is still read *and validated*, so a typo in a deployment's environment fails loudly at
// boot instead of being silently ignored.

import { DEFAULT_RUN_CONCURRENCY } from "@skein-js/agent-protocol";

import { positiveIntegerFromEnv, requirePositiveInteger } from "./env-numbers.js";

/** `pg`'s own default pool size, applied when `PG_POOL_MAX` is unset. Mirrored, not imported: this
 * package must not depend on a Postgres driver to state a number for a warning. */
const PG_DEFAULT_POOL_MAX = 10;

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

/**
 * A warning when the background worker can execute more runs at once than the Postgres pool has
 * connections to serve them — or `undefined` when the two are sized sensibly.
 *
 * Each executing run holds a connection for its checkpoint writes, so `runConcurrency > poolMax` means
 * runs queue on the pool rather than on the queue. That is not an error and not a deadlock, but it is
 * invisible: throughput flattens, `PG_CONNECTION_TIMEOUT_MS` starts firing under load, and nothing in
 * the logs points at the pool. Cheaper to say so once at boot.
 *
 * `poolMax` is `undefined` when `PG_POOL_MAX` is unset, in which case `pg`'s own default (10) applies —
 * which is exactly the case worth warning about, since {@link DEFAULT_RUN_CONCURRENCY} is also 10 and a
 * raised concurrency then silently outgrows a pool nobody chose.
 */
export function describePoolPressure(
  runConcurrency: number,
  poolMax: number | undefined,
): string | undefined {
  const effectivePoolMax = poolMax ?? PG_DEFAULT_POOL_MAX;
  if (runConcurrency <= effectivePoolMax) return undefined;
  const source = poolMax === undefined ? `pg's default of ${PG_DEFAULT_POOL_MAX}` : `PG_POOL_MAX`;
  return (
    `Run concurrency (${runConcurrency}) is higher than the Postgres pool allows (${effectivePoolMax}, ` +
    `from ${source}). Runs will queue waiting for a connection rather than executing, which looks like ` +
    `flat throughput rather than like a pool limit. Raise PG_POOL_MAX to at least ${runConcurrency}, or ` +
    `lower SKEIN_RUN_CONCURRENCY. Note skein opens two pools per instance (store + checkpointer), so ` +
    `budget ${runConcurrency * 2} connections against your database's own cap.`
  );
}
