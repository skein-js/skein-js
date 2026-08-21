// The derivation has to be stable forever and computable by the user — those are the two properties
// that make hashing a phone number acceptable rather than merely private.

import { describe, expect, it } from "vitest";

import { channelThreadMetadata, threadIdForChannelKey } from "./thread-id.js";

describe("threadIdForChannelKey", () => {
  it("is deterministic", () => {
    // The whole contract: a user can compute the thread id for a phone number with no lookup, so
    // ending or erasing a conversation needs no new API.
    expect(threadIdForChannelKey("twilio", "whatsapp:+254712345678")).toBe(
      threadIdForChannelKey("twilio", "whatsapp:+254712345678"),
    );
  });

  it("is a valid v5 UUID", () => {
    const id = threadIdForChannelKey("twilio", "whatsapp:+254712345678");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("separates channels that share a key", () => {
    // An email address can reach both an inbox and a Slack app. Those are two conversations.
    expect(threadIdForChannelKey("email", "ada@example.com")).not.toBe(
      threadIdForChannelKey("slack", "ada@example.com"),
    );
  });

  it("cannot be confused by a key that looks like another pairing", () => {
    // Joining channel and key naively would let ("a", "bc") collide with ("ab", "c"). The length
    // prefix is what stops a channel author from being able to forge another channel's threads by
    // choosing a key.
    expect(threadIdForChannelKey("a", "bc")).not.toBe(threadIdForChannelKey("ab", "c"));
  });

  it("does not leak the key", () => {
    expect(threadIdForChannelKey("twilio", "whatsapp:+254712345678")).not.toContain("254712345678");
  });

  it("keeps the raw key searchable in metadata", () => {
    // The other direction, which is the shape a GDPR erasure request actually arrives in.
    expect(channelThreadMetadata("twilio", "whatsapp:+254712345678")).toEqual({
      skein_channel: "twilio",
      skein_thread_key: "whatsapp:+254712345678",
    });
  });
});
