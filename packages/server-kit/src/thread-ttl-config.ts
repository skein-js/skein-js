// `checkpointer.ttl` (snake_case, minutes) → the drivers' camelCase `ThreadTtlConfig`.
//
// Lives here rather than in `@skein-js/runtime` because **both** assembly paths need it and they do
// not share one: `buildRuntime` for the durable drivers, and the reloadable in-memory runtime that
// `skein dev` returns early into. Having it in one place is what stops thread TTL working under
// `skein start` and silently doing nothing under `skein dev`.

import type { ThreadTtlConfig } from "@skein-js/core";

/** The raw `checkpointer.ttl` block as `langgraph.json` spells it. */
export interface RawThreadTtl {
  default_ttl?: number;
  strategy?: "delete";
  sweep_interval_minutes?: number;
}

/**
 * Map the raw block to {@link ThreadTtlConfig}, or `undefined` when nothing is set — so threads never
 * expire unless asked to, and no sweeper is started.
 *
 * `strategy` is read only to be validated by the config schema: `"delete"` is the only thing an
 * expired thread can become, so there is nothing for the drivers to branch on.
 */
export function resolveThreadTtl(raw: RawThreadTtl | undefined): ThreadTtlConfig | undefined {
  if (!raw) return undefined;
  const ttl: ThreadTtlConfig = {};
  if (typeof raw.default_ttl === "number") ttl.defaultTtl = raw.default_ttl;
  if (typeof raw.sweep_interval_minutes === "number") {
    ttl.sweepIntervalMinutes = raw.sweep_interval_minutes;
  }
  return Object.keys(ttl).length > 0 ? ttl : undefined;
}
