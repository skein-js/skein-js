// The entire Twilio WhatsApp integration.
//
// Everything that is not about Twilio — deduplicating retried deliveries, mapping a phone number to a
// thread, deciding whether this message starts a turn or answers a question the agent is already
// waiting on, delivering the reply durably — belongs to skein and happens around this file. What is
// left is the two things only Twilio knows: how to verify its signature, and what its payload means.
//
// It is loaded by `path:export` from `langgraph.json`, which is the point: this is a file in an
// ordinary project, not a package skein publishes. If a channel needed anything that is not exported
// from `@skein-js/channels`, the export would be missing rather than this file being special.

import { createHmac } from "node:crypto";

import { equalsConstantTime } from "@skein-js/agent-protocol";
import type { Channel } from "@skein-js/channels";

import { createRecordingTwilioClient, createTwilioClient } from "./twilio-client.js";

/**
 * With no credentials set, the client records what it *would* have sent and prints it — so the whole
 * example runs with no Twilio account, no API key and no network.
 */
const client = hasCredentials()
  ? createTwilioClient({
      accountSid: process.env["TWILIO_ACCOUNT_SID"]!,
      authToken: process.env["TWILIO_AUTH_TOKEN"]!,
      from: process.env["TWILIO_WHATSAPP_FROM"]!,
      ...(process.env["TWILIO_TYPING_INDICATOR_URL"]
        ? { typingIndicatorUrl: process.env["TWILIO_TYPING_INDICATOR_URL"] }
        : {}),
    })
  : createRecordingTwilioClient({ log: true });

function hasCredentials(): boolean {
  return Boolean(
    process.env["TWILIO_ACCOUNT_SID"] &&
    process.env["TWILIO_AUTH_TOKEN"] &&
    process.env["TWILIO_WHATSAPP_FROM"],
  );
}

/** Twilio's own token. With none set the example runs offline against a recording client. */
const authToken = process.env["TWILIO_AUTH_TOKEN"] ?? "test_auth_token";

/**
 * The signature Twilio would have sent for this exact URL and form body.
 *
 * Sorted by key, then `key + value` concatenated with no delimiter, appended to the full request URL.
 * Note this signs the **URL**, which is why `public_url` is configuration in `langgraph.json`: behind
 * a proxy the server cannot reconstruct what Twilio saw, and the headers that would tell it are
 * attacker-controlled.
 */
function expectedSignature(url: string, params: Record<string, string>): string {
  const signable = Object.entries(params)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .reduce((acc, [key, value]) => acc + key + value, url);
  return createHmac("sha1", authToken).update(signable, "utf8").digest("base64");
}

export const channel: Channel = {
  name: "twilio",

  /**
   * Step 1 — is this really Twilio?
   *
   * Returns a **principal**, not a boolean, so the message flows through whatever `Auth` block the
   * deployment configured: `@auth.on.threads` handlers see this identity, ownership filters apply, and
   * multi-tenancy works because the identity is derived from provider-verified data.
   */
  verify(request) {
    const signature = request.headers["x-twilio-signature"];
    if (!signature) return false;
    const params = request.form();
    // `equalsConstantTime` rather than `===`, which returns at the first differing byte and lets an
    // attacker who can measure responses recover a valid signature one byte at a time. Its length
    // guard also matters: Node's `timingSafeEqual` *throws* on unequal lengths, so the obvious
    // hand-rolled version turns a forged short signature into a 500.
    if (!equalsConstantTime(expectedSignature(request.url.href, params), signature)) return false;
    return { identity: `channel:twilio:${params["From"] ?? "unknown"}` };
  },

  /** Step 2 — what does this payload mean? */
  parseEvent(request) {
    const message = request.form();
    const body = message["Body"]?.trim();
    // A delivery receipt or a media-only message: acknowledged, no run. Free by design, because a
    // channel that cannot say "not interesting" cheaply ends up answering itself.
    if (!body) return { kind: "ignore" };

    return {
      kind: "event",
      event: {
        // The phone number *is* the conversation. skein hashes it into a thread id, so the number
        // never lands in a primary key — and exports the derivation, so you can still address the
        // thread later without a lookup.
        threadKey: message["From"] ?? "unknown",
        // Twilio's own id for this message. A retried delivery carries the same one, which is what
        // makes a double-send impossible.
        idempotencyKey: message["MessageSid"] ?? "",
        // Where the answer goes. Opaque to skein; handed back to `deliver` unchanged.
        replyTo: { to: message["From"], inReplyTo: message["MessageSid"] },
        input: { messages: [{ role: "human", content: body }] },
        // When this message answers a pending question, the graph's `interrupt()` wants the text the
        // customer typed — not the `{ messages: [...] }` envelope a fresh turn takes. The two shapes
        // differ for any message-shaped graph, and skein will not guess between them.
        resumeWith: body,
      },
    };
  },

  /**
   * Step 3 — send the answer.
   *
   * Durable. This runs inside skein's delivery outbox: the row was written in the run's finalize
   * transaction, so a crash between the run finishing and this call cannot lose the answer, and a
   * throw here is a failed attempt that gets retried with backoff and recorded.
   */
  async deliver(outcome, target) {
    if (outcome.reply === undefined) return;
    const { to } = target as { to?: string };
    if (!to) return;
    await client.sendMessage({ to, body: String(outcome.reply) });
  },

  /**
   * Which run signals this channel wants.
   *
   * Only `progress`, which is all a typing indicator needs. Declaring it is what lets skein pick the
   * cheapest stream that satisfies it — a channel that asked for nothing costs exactly what an API run
   * costs, and this one never pays for token streaming it would only throw away.
   */
  signals: { kinds: ["progress"], keepaliveMs: 10_000 },

  /**
   * React to progress — best-effort, at most once, never retried, never blocking the run.
   *
   * Deliberately the opposite guarantee to `deliver`: retrying a "typing" indicator four minutes late
   * is nonsense. Twilio's indicator is keyed on the *inbound* message and clears itself when the reply
   * lands, so there is nothing to switch off afterwards.
   */
  async onSignal(_signal, target) {
    const { inReplyTo } = target as { inReplyTo?: string };
    // Keyed on the **inbound** message: Twilio renders the indicator against the message it replies
    // to. It expires on its own and clears when the reply lands, so there is no "stop" call to make —
    // which is why this channel subscribes to `progress` and nothing else.
    if (!inReplyTo) return;
    await client.showTyping(inReplyTo);
  },
};
