// The largest page any `SkeinStore` list or search returns — the single place skein resolves that
// number. Both drivers apply it, including when the caller asks for *no* limit, so a search against a
// million-row table can't materialize a million rows. Follows `run-concurrency.ts`: an explicit value
// wins, but the environment is still read *and validated*, so a typo fails loudly at boot.

import { DEFAULT_MAX_PAGE_SIZE } from "@skein-js/core";

import { positiveIntegerFromEnv, requirePositiveInteger } from "./env-numbers.js";

const MAX_PAGE_SIZE_ENV_VARS = ["SKEIN_MAX_PAGE_SIZE"] as const;

/**
 * The one precedence chain for the page bound: an explicit `maxPageSize` store option wins, else
 * `SKEIN_MAX_PAGE_SIZE`, else {@link DEFAULT_MAX_PAGE_SIZE}. The environment is read and validated even
 * when `explicit` is given, so a bad value can't sit unnoticed in a deployment that also passes it.
 *
 * Raising this is the escape hatch for a deployment that genuinely needs bigger pages; it is a
 * *memory* setting, not a correctness one — the wire schemas independently cap a client-supplied
 * `limit` at {@link DEFAULT_MAX_PAGE_SIZE}, so raising it only widens what an absent limit means and
 * what an in-process caller may ask for.
 *
 * `env` is injected (defaulting to `process.env`) so callers — and tests — can resolve against an
 * environment they control.
 */
export function resolveMaxPageSize(
  explicit?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fromEnv = positiveIntegerFromEnv(MAX_PAGE_SIZE_ENV_VARS, env);
  if (explicit === undefined) return fromEnv ?? DEFAULT_MAX_PAGE_SIZE;
  return requirePositiveInteger("store.maxPageSize", explicit);
}
