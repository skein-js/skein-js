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
  secret?: string | string[];
  max_payload_bytes?: number;
  retain_hours?: number;
  allowed_hosts?: string[];
  require_https?: boolean;
}

/**
 * The environment variable holding the signing key(s), comma-separated during a rotation.
 *
 * The preferred source, and the only one that is not committed to the repository. It wins over a
 * literal `secret` in `langgraph.json`, so a deployment can override a checked-in placeholder without
 * editing the file.
 */
export const WEBHOOK_SECRET_ENV = "SKEIN_WEBHOOK_SECRET";

/**
 * Signing keys, in the order they should be tried — env first, then the config block.
 *
 * Returns an empty list when nothing is configured, which means unsigned callbacks: today's
 * behaviour, and not something to fail a boot over.
 */
function resolveSecrets(raw: RawWebhooks, env: Record<string, string | undefined>): string[] {
  const fromEnv = (env[WEBHOOK_SECRET_ENV] ?? "")
    .split(",")
    .map((secret) => secret.trim())
    .filter((secret) => secret.length > 0);
  if (fromEnv.length > 0) return fromEnv;
  const configured = typeof raw.secret === "string" ? [raw.secret] : (raw.secret ?? []);
  return configured.map((secret) => secret.trim()).filter((secret) => secret.length > 0);
}

/**
 * Map the raw block to {@link WebhookDeliveryConfig}, or `undefined` when nothing is set.
 *
 * `undefined` means **defaults, not disabled**, the same distinction `resolveIdempotency` draws: a run
 * that carries a `webhook` owes a callback whether or not a policy was configured. There is no
 * setting that stops skein trying — only `retries.max_attempts: 1`, which asks it to try once.
 */
export function resolveWebhooks(
  raw: RawWebhooks | undefined,
  options: { env?: Record<string, string | undefined>; warn?: (message: string) => void } = {},
): WebhookDeliveryConfig | undefined {
  const env = options.env ?? process.env;
  // The env var alone is enough to turn signing on, so this runs even with no block at all.
  const secrets = resolveSecrets(raw ?? {}, env);
  if (!raw && secrets.length === 0) return undefined;
  const config: WebhookDeliveryConfig = {};
  if (secrets.length > 0) {
    config.secrets = secrets;
    // Warned about, not refused: it does work, and refusing would break a deployment mid-upgrade. But
    // a signing key in `langgraph.json` is a signing key in version control, which is the one thing a
    // signature is supposed to make impossible for an attacker to hold.
    if (!env[WEBHOOK_SECRET_ENV] && raw?.secret !== undefined) {
      options.warn?.(
        `skein: a webhook signing key is set in langgraph.json, which puts it in version control. ` +
          `Set ${WEBHOOK_SECRET_ENV} instead — it takes precedence over this value.`,
      );
    }
  }
  if (!raw) return config;

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
  if (typeof raw.require_https === "boolean") config.requireHttps = raw.require_https;

  return Object.keys(config).length > 0 ? config : undefined;
}
