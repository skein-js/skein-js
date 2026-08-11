// Signing an outbound run-completion callback, so a receiver can tell one from anyone who guessed
// the URL.
//
// **Stripe's format, deliberately and exactly**: `t=<unix seconds>,v1=<hex hmac-sha256>` over
// `"{t}.{raw body}"`. There is no standard here to follow — LangGraph's `webhook` is a bare URL with
// no signature at all — so the tie-break is which shape a receiver is most likely to already have
// verification code for. Adopting a well-known one verbatim means someone integrating skein can
// mostly reuse what they wrote for Stripe; inventing our own would make everyone write it twice.
//
// `node:crypto` for the reason `hash.ts` gives: synchronous, and present on Node, Bun and Deno. On an
// edge runtime `crypto.subtle.sign` is the async replacement, and this file and its verifier are the
// only two that would change.

import { createHmac } from "node:crypto";

/** The header a signed delivery carries. */
export const SIGNATURE_HEADER = "x-skein-signature";

/**
 * Sign `body` at `timestampSeconds`, returning the header value.
 *
 * The timestamp is **inside** the signed string rather than merely alongside it. That is what makes a
 * replay detectable: an attacker who captures a genuine callback cannot move its timestamp forward
 * without invalidating the signature, so a receiver enforcing a tolerance window can reject a
 * yesterday's-callback-resent-today without any state of its own.
 */
export function signDelivery(input: {
  /** The signing key. When rotating, this is the *new* one — see `resolveWebhookSecrets`. */
  secret: string;
  timestampSeconds: number;
  /** The exact bytes being sent. Re-serializing the payload will not reproduce this. */
  body: string;
}): string {
  const signature = createHmac("sha256", input.secret)
    .update(`${input.timestampSeconds}.${input.body}`, "utf8")
    .digest("hex");
  return `t=${input.timestampSeconds},v1=${signature}`;
}
