// Mapping an external identity — a phone number, an issue URL, an email thread — onto a skein thread.

import { createHash } from "node:crypto";

/**
 * The namespace UUIDv5 hashes under. Fixed forever: changing it would silently orphan every existing
 * conversation, because the same phone number would start deriving a different thread.
 */
const SKEIN_CHANNEL_NAMESPACE = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";

/**
 * The thread an event on `threadKey` belongs to. Deterministic: the same channel and key always give
 * the same id, for the life of the deployment.
 *
 * **Hashed rather than verbatim, but exported rather than hidden**, and the second half is what makes
 * the first half acceptable. Putting `whatsapp:+254712345678` in a primary key spreads a phone number
 * into indexes, logs and backups, which carries real GDPR weight. But an id the user cannot recompute
 * is not a primitive — it would take away "end this customer's conversation", "show me their history"
 * and "erase their data" while offering nothing back. Because this is a pure function of inputs the
 * caller already has, all three stay one call away with no lookup:
 *
 * ```ts
 * // End it. The next inbound message starts a fresh conversation under the same id.
 * await client.threads.delete(threadIdForChannelKey("twilio", "whatsapp:+254712345678"));
 * ```
 *
 * The raw key is also stamped into the thread's metadata by the pipeline, so
 * `POST /threads/search { metadata: { … } }` answers the same question from the other direction —
 * which is the shape an erasure request actually arrives in.
 *
 * A channel that would rather choose the id itself returns `threadId` on the event instead, and skein
 * does no transformation at all.
 */
export function threadIdForChannelKey(channelName: string, threadKey: string): string {
  // UUIDv5 by hand rather than pulling in a dependency: it is a SHA-1 over the namespace bytes plus
  // the name, with the version and variant bits overwritten. `node:crypto` already has the hash, and
  // this is the whole of the algorithm.
  const namespaceBytes = Buffer.from(SKEIN_CHANNEL_NAMESPACE.replace(/-/g, ""), "hex");
  // The channel name is part of the input, so two channels keyed on the same string — an email address
  // reaching both an inbox and a Slack app — do not collide onto one conversation. Length-prefixed
  // rather than joined by a separator, so no key containing the separator can forge another pairing.
  const name = Buffer.from(`${channelName.length}:${channelName}${threadKey}`, "utf8");
  const hash = createHash("sha1").update(namespaceBytes).update(name).digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** The metadata the pipeline stamps on a thread it derives, so the raw key stays searchable. */
export function channelThreadMetadata(
  channelName: string,
  threadKey: string,
): Record<string, string> {
  return { skein_channel: channelName, skein_thread_key: threadKey };
}
