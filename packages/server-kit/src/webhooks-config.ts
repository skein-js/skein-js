// The `langgraph.json` `skein.webhooks` block (snake_case) → the engine's camelCase config.
//
// Here rather than in `@skein-js/runtime` for exactly the reason `ttl-config.ts` and
// `idempotency-config.ts` give: both assembly paths need it and they do not share one. A retry policy
// that worked under `skein start` and silently did nothing under `skein dev` is the same failure
// those two files exist to prevent, and it would be harder to notice here — the symptom is a callback
// that eventually arrives in production and never arrives in dev.

import type { WebhookDeliveryConfig } from "@skein-js/agent-protocol";

/** The raw `skein.webhooks` block as `langgraph.json` spells it. */
export interface RawWebhooks {
  retries?: {
    max_attempts?: number;
    initial_delay_ms?: number;
  };
  max_payload_bytes?: number;
  retain_hours?: number;
  allowed_hosts?: string[];
}

/**
 * Map the raw block to {@link WebhookDeliveryConfig}, or `undefined` when nothing is set.
 *
 * `undefined` means **defaults, not disabled**, the same distinction `resolveIdempotency` draws: a run
 * that carries a `webhook` owes a callback whether or not a policy was configured. There is no
 * setting that stops skein trying — only `retries.max_attempts: 1`, which asks it to try once.
 */
export function resolveWebhooks(raw: RawWebhooks | undefined): WebhookDeliveryConfig | undefined {
  if (!raw) return undefined;
  const config: WebhookDeliveryConfig = {};

  const retries: NonNullable<WebhookDeliveryConfig["retries"]> = {};
  if (typeof raw.retries?.max_attempts === "number") retries.maxAttempts = raw.retries.max_attempts;
  if (typeof raw.retries?.initial_delay_ms === "number") {
    retries.initialDelayMs = raw.retries.initial_delay_ms;
  }
  if (Object.keys(retries).length > 0) config.retries = retries;

  if (typeof raw.max_payload_bytes === "number") config.maxPayloadBytes = raw.max_payload_bytes;
  if (typeof raw.retain_hours === "number") config.retainHours = raw.retain_hours;
  // An explicitly empty list is dropped rather than carried, so it cannot be read as "allow nothing"
  // — a policy no caller can have meant, whose symptom would be every callback dead on arrival.
  if (Array.isArray(raw.allowed_hosts) && raw.allowed_hosts.length > 0) {
    config.allowedHosts = [...raw.allowed_hosts];
  }

  return Object.keys(config).length > 0 ? config : undefined;
}
