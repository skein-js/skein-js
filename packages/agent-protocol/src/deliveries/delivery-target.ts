// Whether a callback may be sent to a URL at all, and how that URL may be written down.

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
 * A delivery target skein minted rather than one a caller supplied — today, a channel reply.
 *
 * Recognised by scheme, which is safe **only because** the run-create schema restricts `webhook` to
 * `http`/`https`. If that restriction is ever relaxed, this becomes a way to bypass both guards above.
 */
function isServerDerivedTarget(url: string): boolean {
  return url.startsWith("skein+channel://");
}
