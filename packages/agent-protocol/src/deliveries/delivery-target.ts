// Whether a callback may be sent to a URL at all, and how that URL may be written down.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { WebhookDeliveryConfig } from "./delivery-config.js";

export async function deliveryTargetError(
  target: string,
  config?: WebhookDeliveryConfig,
): Promise<string | undefined> {
  if (isServerDerivedTarget(target)) return undefined;
  if (config?.disabled) return "HTTP webhook delivery is disabled by http.disable_webhooks";
  const existing =
    disallowedHost(target, config?.allowedHosts) ?? insecureTransport(target, config?.requireHttps);
  if (existing) return existing;
  if (!config?.url) return undefined;
  const policy = config.url;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "webhook URL is not a valid absolute URL";
  }
  if (policy.maxUrlLength !== undefined && target.length > policy.maxUrlLength)
    return "webhook URL exceeds webhooks.url.max_url_length";
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    policy.allowedDomains &&
    !policy.allowedDomains.some((domain) => {
      const normalized = domain.toLowerCase();
      return normalized.startsWith("*.")
        ? host.endsWith(normalized.slice(1)) && host.length > normalized.length - 1
        : host === normalized;
    })
  )
    return "webhook host is not in webhooks.url.allowed_domains";
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (policy.allowedPorts && !policy.allowedPorts.includes(port))
    return "webhook port is not in webhooks.url.allowed_ports";
  if (!policy.disableLoopback) return undefined;
  try {
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (addresses.some(({ address }) => isLoopbackAddress(address)))
      return "webhook loopback destinations are disabled by webhooks.url.disable_loopback";
  } catch {
    return "webhook destination could not be resolved for webhooks.url.disable_loopback";
  }
  return undefined;
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (
    normalized === "::1" ||
    normalized === "::" ||
    normalized === "0.0.0.0" ||
    normalized.startsWith("127.")
  )
    return true;
  if (!normalized.startsWith("::ffff:")) return false;
  const mapped = normalized.slice(7);
  return mapped.includes(".")
    ? isLoopbackAddress(mapped)
    : Number.parseInt(mapped.split(":")[0]!, 16) >>> 8 === 127 || mapped === "0:0";
}

/**
 * Why `url`'s host is not deliverable, or `undefined` when it is. An absent or empty allowlist
 * permits everything, which is today's behaviour and stays the default.
 *
 * Shared by the inline attempt and the queue-driven one, so the two cannot come to disagree about
 * what an allowlist admits — the way they would disagree is one of them accepting a host the other
 * refuses, which reads to an operator as a callback that arrives only sometimes.
 */
export function disallowedHost(url: string, allowedHosts?: readonly string[]): string | undefined {
  if (!allowedHosts || allowedHosts.length === 0) return undefined;
  // A server-derived target has no host to allow-list. Both guards exist to bound where a *caller*
  // can make the server send a request, and the run-create schema already refuses this scheme from a
  // caller — so applying them here would only break replies the deployment configured itself.
  if (isServerDerivedTarget(url)) return undefined;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return `webhook URL ${redactWebhookUrl(url)} is not a valid absolute URL`;
  }
  // Exact hostname match, deliberately: a suffix match on "example.com" would also accept
  // "notexample.com", which is the classic way an allowlist stops being one.
  return allowedHosts.includes(host)
    ? undefined
    : `webhook host "${host}" is not in skein.webhooks.allowed_hosts`;
}

/** Why this URL may not be sent to over plaintext, or `undefined` when it may. */
export function insecureTransport(url: string, requireHttps?: boolean): string | undefined {
  if (!requireHttps) return undefined;
  // See `disallowedHost`: nothing about a channel reply travels over plaintext HTTP for this check to
  // protect — the channel's own transport is its business, and it never reaches the outbox's fetch.
  if (isServerDerivedTarget(url)) return undefined;
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return `webhook URL ${redactWebhookUrl(url)} is not a valid absolute URL`;
  }
  return protocol === "https:"
    ? undefined
    : `webhook URL uses ${protocol} and skein.webhooks.require_https is set`;
}

/**
 * A webhook URL with its path redacted, for logs.
 *
 * **The path is frequently the credential.** Slack, Discord and Teams all authenticate a webhook by
 * an unguessable path — `https://hooks.slack.com/services/T…/B…/XXXX` — so logging the URL verbatim
 * writes a bearer token into every log sink the deployment has. That was survivable when a failure
 * was logged once; with retries it happens on every attempt, and a `dead` delivery leaves a dozen
 * copies of the secret behind.
 *
 * The host is kept because it is what an operator actually needs to see, and the delivery id is
 * already in every one of these lines and is the real correlation key.
 */
export function redactWebhookUrl(url: string): string {
  try {
    const { protocol, host, pathname } = new URL(url);
    return pathname === "/" ? `${protocol}//${host}` : `${protocol}//${host}/…`;
  } catch {
    // Not parseable, so it has no structure to preserve — and no way to tell a credential from a
    // typo. Say nothing about its contents.
    return "<unparseable url>";
  }
}

/**
 * A delivery target the host minted: channel replies and the supported BullMQ access adapter.
 *
 * Recognised by scheme, which is safe **only because** the run-create schema restricts `webhook` to
 * `http`/`https`. If that restriction is ever relaxed, this becomes a way to bypass both guards above.
 */
export function isServerDerivedTarget(url: string): boolean {
  return url.startsWith("skein+channel://") || url.startsWith("skein-bullmq://");
}
