// The `langgraph.json` `skein.idempotency` block (snake_case) → the engine's camelCase config.
//
// Here rather than in `@skein-js/runtime` for exactly the reason `ttl-config.ts` gives: both
// assembly paths need it and they do not share one. That file exists because a TTL once worked under
// `skein start` and silently did nothing under `skein dev`; this one is the same shape of knob, and
// would fail the same way.

import type { IdempotencyConfig } from "@skein-js/agent-protocol";

/** The raw `skein.idempotency` block as `langgraph.json` spells it. */
export interface RawIdempotency {
  retention_hours?: number;
  in_flight_minutes?: number;
  sweep_interval_minutes?: number;
}

/**
 * Map the raw block to {@link IdempotencyConfig}, or `undefined` when nothing is set.
 *
 * Note what `undefined` means here, because it differs from its neighbours: **defaults, not
 * disabled.** `resolveStoreTtl` returning `undefined` genuinely means items never expire, but a
 * caller who sends `Idempotency-Key` has been promised their retry will not start a second run —
 * there is no configuration under which the header stops being honoured, only one that tunes how
 * long the promise lasts.
 */
export function resolveIdempotency(raw: RawIdempotency | undefined): IdempotencyConfig | undefined {
  if (!raw) return undefined;
  const config: IdempotencyConfig = {};
  if (typeof raw.retention_hours === "number") config.retentionHours = raw.retention_hours;
  if (typeof raw.in_flight_minutes === "number") config.inFlightMinutes = raw.in_flight_minutes;
  if (typeof raw.sweep_interval_minutes === "number") {
    config.sweepIntervalMinutes = raw.sweep_interval_minutes;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}
