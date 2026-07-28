// Reading and validating a positive-integer setting from the environment — shared by the knobs that
// resolve this way, currently `resolveRunConcurrency`, `resolveMemoryBusLimits`, and `resolveMaxPageSize`. Both follow the
// same rule: an explicit value wins, but the environment is still read *and validated*, so a typo in
// a deployment fails loudly at boot instead of being silently ignored.
//
// `resolveShutdownGraceMs` deliberately does not use this and keeps its own validator: zero is a
// legitimate value there ("abort in-flight runs immediately"), so it needs non-negative, not positive.

// Imported from the `/errors` subpath, not the package root: the root barrel pulls in the
// `langgraph.json` loader and with it `@langchain/langgraph-api`, which would then land in every
// adapter bundle for the sake of one error class. Guarded by `static-imports.test.ts`.
import { SkeinConfigError } from "@skein-js/config/errors";

/** Parse `raw` as a positive integer, naming `source` in the error so a bad value is traceable. */
export function requirePositiveInteger(source: string, raw: string | number): number {
  const parsed = Number(raw);
  // `Number.isSafeInteger`, not `isInteger`: `1e21` is an integer, but it stringifies in exponential
  // notation and overflows a Postgres bigint, so it passes boot validation and then breaks every query
  // that uses it. Nothing this validates is a legitimate count above 2^53.
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new SkeinConfigError(`${source} must be a positive integer (got "${String(raw)}").`);
  }
  return parsed;
}

/**
 * The first of `names` that is set to a non-blank value, parsed and validated; `undefined` when none
 * is. Several names because some knobs accept a LangGraph-compatible alias alongside the skein one.
 *
 * Blank counts as unset. `Number("")` is 0, which would otherwise throw a confusing
 * 'must be a positive integer (got "")' for a variable the user effectively left empty.
 */
export function positiveIntegerFromEnv(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
): number | undefined {
  for (const name of names) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") continue;
    return requirePositiveInteger(name, raw);
  }
  return undefined;
}
