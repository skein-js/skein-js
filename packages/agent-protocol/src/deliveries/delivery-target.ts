// Whether a callback may be sent to a URL at all.

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
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return `webhook URL "${url}" is not a valid absolute URL`;
  }
  // Exact hostname match, deliberately: a suffix match on "example.com" would also accept
  // "notexample.com", which is the classic way an allowlist stops being one.
  return allowedHosts.includes(host)
    ? undefined
    : `webhook host "${host}" is not in skein.webhooks.allowed_hosts`;
}
