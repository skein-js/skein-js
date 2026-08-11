// Verifying a skein callback — shipped, not merely documented.
//
// This is the receiver's half, and it lives in `@skein-js/agent-protocol` on purpose: that package
// installs with no graph runtime, so a service whose only relationship with skein is *receiving*
// callbacks can depend on it for this and nothing else. A verifier described in prose is a verifier
// every integrator writes slightly wrong — most often by comparing with `===`, or by checking the
// signature and ignoring the timestamp.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Why a callback was refused. Distinct values because they mean different things to an operator. */
export type SignatureFailure = "missing" | "malformed" | "stale" | "mismatch";

export interface VerifySignatureInput {
  /** The `X-Skein-Signature` header, verbatim. */
  header: string | undefined | null;
  /** The **raw request body**, before any JSON parsing — see {@link verifySkeinSignature}. */
  body: string;
  /**
   * Every secret currently accepted. During a rotation this holds both, so callbacks signed with
   * either are honoured; outside one it holds a single value.
   */
  secrets: readonly string[];
  /**
   * How far the callback's timestamp may be from now, in seconds. Defaults to 300.
   *
   * This is the replay defence, and it is why the timestamp is signed rather than sent beside the
   * signature: a captured callback stays valid only for this long.
   */
  toleranceSeconds?: number;
  /** Now, in unix seconds. Injected so a test need not move the wall clock. */
  nowSeconds?: number;
}

export type VerifySignatureResult =
  { ok: true } | { ok: false; reason: SignatureFailure; message: string };

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Check a callback's signature and freshness.
 *
 * **`body` must be the raw bytes**, captured before the JSON was parsed. `JSON.stringify(req.body)`
 * will not do: key order, whitespace and number formatting are not guaranteed to round-trip, so a
 * re-serialized body produces a different digest and every genuine callback fails. In Express that
 * means `express.raw({ type: "application/json" })` on this route, or `express.json({ verify })`.
 */
export function verifySkeinSignature(input: VerifySignatureInput): VerifySignatureResult {
  if (!input.header) {
    return { ok: false, reason: "missing", message: "no X-Skein-Signature header" };
  }
  const parsed = parseHeader(input.header);
  if (!parsed) {
    return {
      ok: false,
      reason: "malformed",
      message: `X-Skein-Signature is not of the form "t=…,v1=…" (got "${input.header}")`,
    };
  }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  // Absolute, so a callback timestamped in the *future* is refused too — otherwise an attacker could
  // mint one that stays valid indefinitely.
  if (Math.abs(now - parsed.timestampSeconds) > tolerance) {
    return {
      ok: false,
      reason: "stale",
      message: `callback timestamp is ${Math.abs(now - parsed.timestampSeconds)}s away from now, outside the ${tolerance}s tolerance`,
    };
  }

  const signed = `${parsed.timestampSeconds}.${input.body}`;
  // **Every** secret is tried, and the loop does not stop early on a match, because rotation is the
  // whole reason this takes a list: while both keys are live, callbacks arrive signed with either.
  const matched = input.secrets.some((secret) =>
    equalsConstantTime(
      createHmac("sha256", secret).update(signed, "utf8").digest("hex"),
      parsed.v1,
    ),
  );
  if (!matched) {
    return { ok: false, reason: "mismatch", message: "signature does not match the body" };
  }
  return { ok: true };
}

/** `t=…,v1=…`, tolerant of extra comma-separated fields so a future `v2=` does not break this. */
function parseHeader(header: string): { timestampSeconds: number; v1: string } | undefined {
  let timestampSeconds: number | undefined;
  let v1: string | undefined;
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (!value) continue;
    if (key === "t") {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) timestampSeconds = seconds;
    }
    if (key === "v1") v1 = value;
  }
  return timestampSeconds !== undefined && v1 !== undefined ? { timestampSeconds, v1 } : undefined;
}

/**
 * Compare two hex digests without leaking where they diverge.
 *
 * `===` on a signature is a timing oracle: it returns at the first differing byte, so an attacker who
 * can send many callbacks and measure the response can recover a valid signature one byte at a time.
 * The length check first is safe — `timingSafeEqual` throws on unequal lengths, and the length of a
 * digest is not a secret.
 */
function equalsConstantTime(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
