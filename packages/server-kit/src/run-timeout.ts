// How long a single run may execute before it is aborted — the one place skein resolves that number.
//
// `deps.runTimeoutMs` has always been honoured by the run engine, but nothing exposed it: an operator
// could only reach it by constructing `ProtocolDeps` by hand, which the CLI path never does. So a graph
// that hangs — a model call with no timeout of its own, an infinite loop in a node — held a worker slot
// until the process restarted.
//
// **Opt-in, deliberately.** Unlike the other bounds in this area, a default here would be wrong: legitimate
// agent runs take minutes, and a research or multi-step tool graph can run much longer than that. A
// default would turn "slow but working" into "killed", which is the failure the timeout is meant to
// prevent. Set it when you know your own ceiling.

import { positiveIntegerFromEnv, requirePositiveInteger } from "./env-numbers.js";

const RUN_TIMEOUT_ENV_VARS = ["SKEIN_RUN_TIMEOUT_MS"] as const;

/**
 * The one precedence chain for the run timeout: an explicit value (the CLI's `--run-timeout`, or a
 * `runTimeoutMs` on the deps) wins, else `SKEIN_RUN_TIMEOUT_MS`, else **unset** — no timeout.
 *
 * The environment is read and validated even when `explicit` is given, so a typo can't sit unnoticed in
 * a deployment that also passes the option.
 *
 * `env` is injected (defaulting to `process.env`) so callers — and tests — can resolve against an
 * environment they control.
 */
export function resolveRunTimeoutMs(
  explicit?: number,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const fromEnv = positiveIntegerFromEnv(RUN_TIMEOUT_ENV_VARS, env);
  if (explicit === undefined) return fromEnv;
  return requirePositiveInteger("runTimeoutMs", explicit);
}
