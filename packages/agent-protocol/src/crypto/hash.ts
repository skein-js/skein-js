// The first cryptography in the repo. Kept in its own directory so the next piece — HMAC signing for
// outbound webhook deliveries — has an obvious home beside it rather than being inlined wherever it
// is first needed.
//
// `node:crypto` rather than `crypto.subtle`: it is synchronous, which keeps the fingerprint out of
// the request's await chain, and it is present on Node, Bun and Deno. It is NOT present on an edge
// runtime — if skein ever serves one, `crypto.subtle.digest` is the async replacement, and this is
// the only place that would change.

import { createHash } from "node:crypto";

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
