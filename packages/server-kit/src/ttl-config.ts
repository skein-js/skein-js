// The two `langgraph.json` TTL blocks (snake_case, minutes) → the drivers' camelCase config.
//
// Lives here rather than in `@skein-js/runtime` because **both** assembly paths need them and they do
// not share one: `buildRuntime` for the durable drivers, and the reloadable in-memory runtime that
// `skein dev` returns early into. Having them in one place is what stops a TTL working under
// `skein start` and silently doing nothing under `skein dev`.

import type { StoreTtlConfig, ThreadTtlConfig } from "@skein-js/core";

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

/** The raw `store.ttl` block as `langgraph.json` spells it. */
export interface RawStoreTtl {
  default_ttl?: number;
  refresh_on_read?: boolean;
  sweep_interval_minutes?: number;
}

/**
 * Map the raw `store.ttl` block to {@link StoreTtlConfig}, or `undefined` when nothing is set — so
 * store items never expire unless asked to.
 */
export function resolveStoreTtl(raw: RawStoreTtl | undefined): StoreTtlConfig | undefined {
  if (!raw) return undefined;
  const ttl: StoreTtlConfig = {};
  if (typeof raw.default_ttl === "number") ttl.defaultTtl = raw.default_ttl;
  if (typeof raw.refresh_on_read === "boolean") ttl.refreshOnRead = raw.refresh_on_read;
  if (typeof raw.sweep_interval_minutes === "number") {
    ttl.sweepIntervalMinutes = raw.sweep_interval_minutes;
  }
  return Object.keys(ttl).length > 0 ? ttl : undefined;
}
