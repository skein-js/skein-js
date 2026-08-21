// Where a settled run's answer goes when the caller was a channel rather than an HTTP client.
//
// **This rides the delivery outbox rather than inventing anything.** A channel's reply needs exactly
// what a webhook needs — write it in the run's finalize transaction, retry it with backoff, record the
// attempts, replay it after a crash — and all of that already exists. Adding a second delivery
// mechanism beside it would mean a second thing to make crash-safe, and the proposal's own test was
// that if the pipeline needs storage of its own, the gap belongs in the outbox instead.
//
// So the delivery's `url` carries the channel and its opaque reply target, and the configured
// dispatcher is wrapped to recognise it.

/** The scheme that marks a delivery as belonging to a channel rather than to an HTTP receiver. */
export const CHANNEL_DELIVERY_SCHEME = "skein+channel:";

export interface ChannelDeliveryTarget {
  channelName: string;
  /** Whatever the channel put on `InboundEvent.replyTo`. Opaque to skein. */
  replyTo: unknown;
}

/**
 * Encode a channel reply target as a delivery URL.
 *
 * **Only ever produced here, and unreachable from a request.** The run-create schema restricts
 * `webhook` to `http`/`https`, so a caller cannot hand the server this scheme and have its own
 * message delivered through somebody's Twilio account — which is exactly what an earlier version of
 * this design allowed, because `z.string().url()` happily accepts any scheme. The restriction is what
 * makes keying the dispatcher on the scheme safe; without it this would be a forgery vector rather
 * than an encoding.
 */
export function toChannelDeliveryUrl(target: ChannelDeliveryTarget): string {
  const payload = Buffer.from(JSON.stringify(target.replyTo ?? null), "utf8").toString("base64url");
  return `${CHANNEL_DELIVERY_SCHEME}//${encodeURIComponent(target.channelName)}/${payload}`;
}

/** Decode one, or `undefined` when this delivery is an ordinary webhook. */
export function parseChannelDeliveryUrl(url: string): ChannelDeliveryTarget | undefined {
  if (!url.startsWith(`${CHANNEL_DELIVERY_SCHEME}//`)) return undefined;
  const rest = url.slice(`${CHANNEL_DELIVERY_SCHEME}//`.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  const channelName = decodeURIComponent(rest.slice(0, slash));
  try {
    const replyTo: unknown = JSON.parse(
      Buffer.from(rest.slice(slash + 1), "base64url").toString("utf8"),
    );
    return { channelName, replyTo };
  } catch {
    // A malformed target is not a channel delivery. Returning `undefined` sends it down the ordinary
    // webhook path, where it fails visibly as a bad URL rather than being silently dropped here.
    return undefined;
  }
}

/** True when this URL addresses a channel — for the guards that only make sense for real hosts. */
export function isChannelDeliveryUrl(url: string): boolean {
  return url.startsWith(`${CHANNEL_DELIVERY_SCHEME}//`);
}
