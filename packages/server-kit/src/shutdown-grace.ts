// How long a shutting-down instance lets in-flight runs finish before aborting them — the single
// place skein resolves that number. Every framework adapter (`worker.shutdownGraceMs`), the CLI, and
// the environment (`SKEIN_SHUTDOWN_GRACE_MS`) funnel through here, so the surfaces can't disagree.
// Mirrors `resolveRunConcurrency` next door: an explicit value wins, but the environment is still
// read *and validated*, so a typo in a deployment fails loudly at boot instead of silently reverting
// to the default. Env-only by design — this is a property of where you deploy (each platform allows a
// different SIGTERM→SIGKILL window), not of a command line.

import { DEFAULT_SHUTDOWN_GRACE_MS } from "@skein-js/agent-protocol";
// Imported from the `/errors` subpath, not the package root: the root barrel pulls in the
// `langgraph.json` loader and with it `@langchain/langgraph-api`, which would then land in every
// adapter bundle for the sake of one error class. Guarded by `static-imports.test.ts`.
import { SkeinConfigError } from "@skein-js/config/errors";

const SHUTDOWN_GRACE_ENV_VAR = "SKEIN_SHUTDOWN_GRACE_MS";

function requireNonNegativeInteger(source: string, raw: string | number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new SkeinConfigError(
      `${source} must be a non-negative integer in milliseconds (got "${String(raw)}").`,
    );
  }
  return parsed;
}

/** The declared grace, or undefined when the variable is unset (or blank). */
function shutdownGraceFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[SHUTDOWN_GRACE_ENV_VAR];
  // Blank counts as unset — `Number("")` is 0, which would otherwise silently mean "abort in-flight
  // runs immediately" for a variable the user effectively left empty.
  if (raw === undefined || raw.trim() === "") return undefined;
  return requireNonNegativeInteger(SHUTDOWN_GRACE_ENV_VAR, raw);
}

/**
 * The one precedence chain for the shutdown drain window: an explicit `worker.shutdownGraceMs` wins,
 * else `SKEIN_SHUTDOWN_GRACE_MS`, else {@link DEFAULT_SHUTDOWN_GRACE_MS}. The environment is read and
 * validated even when `explicit` is given, so a bad value can't sit unnoticed in a deployment that
 * also passes the option.
 *
 * Zero is allowed and means "abort in-flight runs immediately" — a legitimate choice for a fleet that
 * relies on queue redelivery instead of draining.
 *
 * `env` is injected (defaulting to `process.env`) so callers — and tests — can resolve against an
 * environment they control.
 */
export function resolveShutdownGraceMs(
  explicit?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fromEnv = shutdownGraceFromEnv(env);
  if (explicit === undefined) return fromEnv ?? DEFAULT_SHUTDOWN_GRACE_MS;
  return requireNonNegativeInteger("worker.shutdownGraceMs", explicit);
}
