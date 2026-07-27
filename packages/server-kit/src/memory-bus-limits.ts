// How much the in-memory event bus is allowed to retain — the single place skein resolves those
// bounds. Mirrors `resolveRunConcurrency()`: an explicit value wins, but the environment is still
// read *and validated*, so a typo in a deployment's environment fails loudly at boot instead of being
// silently ignored.
//
// These matter beyond `skein dev`. `embedPostgresGraphs` falls back to the memory bus whenever no
// Redis URL is configured — a common first production deploy — so a long-lived process is bounded by
// whatever these resolve to. See docs/embedding.md.

import {
  DEFAULT_MEMORY_BUS_MAX_FRAMES_PER_RUN,
  DEFAULT_MEMORY_BUS_MAX_RETAINED_RUNS,
  type MemoryRunEventBusOptions,
} from "@skein-js/storage-memory";

import { positiveIntegerFromEnv, requirePositiveInteger } from "./env-numbers.js";

const MAX_RETAINED_RUNS_ENV = "SKEIN_MEMORY_BUS_MAX_RETAINED_RUNS";
const MAX_FRAMES_PER_RUN_ENV = "SKEIN_MEMORY_BUS_MAX_FRAMES_PER_RUN";

/**
 * The two bounds this resolves. `finishedIdTtlMs` and `now` are deliberately not included — the TTL
 * matches the Redis driver's closed-marker window and is not something a deployment tunes, and the
 * clock exists for tests.
 */
export type ResolvedMemoryBusLimits = Required<
  Pick<MemoryRunEventBusOptions, "maxRetainedRuns" | "maxFramesPerRun">
>;

/**
 * Resolve the memory bus's retention bounds from explicit options, then the environment, then the
 * defaults. Both variables are validated even when an explicit value is supplied, so a bad one can't
 * sit unnoticed in a deployment that also passes options.
 *
 * `env` is injected (defaulting to `process.env`) so callers — and tests — can resolve against an
 * environment they control.
 *
 * @example
 * ```ts
 * new MemoryRunEventBus(resolveMemoryBusLimits());
 * ```
 */
export function resolveMemoryBusLimits(
  explicit: MemoryRunEventBusOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMemoryBusLimits {
  const retainedFromEnv = positiveIntegerFromEnv([MAX_RETAINED_RUNS_ENV], env);
  const framesFromEnv = positiveIntegerFromEnv([MAX_FRAMES_PER_RUN_ENV], env);

  return {
    maxRetainedRuns:
      explicit.maxRetainedRuns === undefined
        ? (retainedFromEnv ?? DEFAULT_MEMORY_BUS_MAX_RETAINED_RUNS)
        : requirePositiveInteger("maxRetainedRuns", explicit.maxRetainedRuns),
    maxFramesPerRun:
      explicit.maxFramesPerRun === undefined
        ? (framesFromEnv ?? DEFAULT_MEMORY_BUS_MAX_FRAMES_PER_RUN)
        : requirePositiveInteger("maxFramesPerRun", explicit.maxFramesPerRun),
  };
}
