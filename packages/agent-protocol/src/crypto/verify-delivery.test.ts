// Success criterion 2, as a CI gate: "a receiver can reject a forged callback and a replayed
// callback using only the documented headers and the shared secret."
//
// The example receiver demonstrates it runnably; this is what fails the build if it stops being true,
// since `examples/*` are excluded from the affected run.

import { describe, expect, it } from "vitest";

import { signDelivery } from "./sign-delivery.js";
import { verifySkeinSignature } from "./verify-delivery.js";

const SECRET = "whsec_test_key";
const NOW = 1_800_000_000;
const BODY = JSON.stringify({ run_id: "run-1", status: "success", values: { answer: 42 } });

const headerFor = (overrides: { secret?: string; at?: number; body?: string } = {}) =>
  signDelivery({
    secret: overrides.secret ?? SECRET,
    timestampSeconds: overrides.at ?? NOW,
    body: overrides.body ?? BODY,
  });

const verify = (
  header: string | undefined | null,
  over: Partial<{ body: string; at: number }> = {},
) =>
  verifySkeinSignature({
    header,
    body: over.body ?? BODY,
    secrets: [SECRET],
    nowSeconds: over.at ?? NOW,
  });

describe("skein delivery signatures", () => {
  it("accepts a genuine callback", () => {
    expect(verify(headerFor())).toEqual({ ok: true });
  });

  it("emits Stripe's format, so a receiver can reuse verification code it already has", () => {
    expect(headerFor()).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  // A forgery: someone who guessed the URL and POSTed a plausible body.
  it("rejects a callback signed with the wrong key", () => {
    const result = verify(headerFor({ secret: "whsec_not_ours" }));
    expect(result).toMatchObject({ ok: false, reason: "mismatch" });
  });

  it("rejects a body altered after signing, down to one byte", () => {
    const tampered = BODY.replace('"success"', '"error"  ');
    expect(tampered).toHaveLength(BODY.length);
    expect(verify(headerFor(), { body: tampered })).toMatchObject({
      ok: false,
      reason: "mismatch",
    });
  });

  // A replay: a genuine callback captured off the wire and sent again later. The timestamp is inside
  // the signed string, so it cannot be moved forward without invalidating the signature — which is
  // what lets a receiver refuse this with no state of its own.
  it("rejects a replayed callback once it is outside the tolerance", () => {
    const captured = headerFor();
    expect(verify(captured, { at: NOW + 60 })).toEqual({ ok: true });

    const result = verify(captured, { at: NOW + 3_600 });
    expect(result).toMatchObject({ ok: false, reason: "stale" });
  });

  it("rejects a callback timestamped in the future", () => {
    // Otherwise an attacker could mint one that stays valid for as long as they like.
    expect(verify(headerFor({ at: NOW + 3_600 }))).toMatchObject({ ok: false, reason: "stale" });
  });

  it("rejects a missing or malformed header rather than passing it through", () => {
    expect(verify(undefined)).toMatchObject({ ok: false, reason: "missing" });
    expect(verify("")).toMatchObject({ ok: false, reason: "missing" });
    expect(verify("deadbeef")).toMatchObject({ ok: false, reason: "malformed" });
    expect(verify("t=abc,v1=x")).toMatchObject({ ok: false, reason: "malformed" });
  });

  // Rotation is the whole reason `secrets` is a list. Removing the outgoing key before every
  // receiver has the new one is what silently drops deliveries.
  it("accepts either key while a rotation is in flight", () => {
    const rotating = { body: BODY, secrets: ["whsec_new", "whsec_old"], nowSeconds: NOW };

    for (const secret of ["whsec_new", "whsec_old"]) {
      expect(verifySkeinSignature({ ...rotating, header: headerFor({ secret }) })).toEqual({
        ok: true,
      });
    }
    expect(
      verifySkeinSignature({ ...rotating, header: headerFor({ secret: "whsec_retired" }) }),
    ).toMatchObject({ ok: false, reason: "mismatch" });
  });

  it("refuses everything when the receiver has no keys", () => {
    expect(
      verifySkeinSignature({ header: headerFor(), body: BODY, secrets: [], nowSeconds: NOW }),
    ).toMatchObject({ ok: false, reason: "mismatch" });
  });

  // The mistake this catches is the one integrators actually make: verifying against a body
  // re-serialized from the parsed JSON. Key order and spacing do not round-trip.
  it("fails on a re-serialized body, which is why the docs insist on the raw bytes", () => {
    const reserialized = JSON.stringify(JSON.parse(BODY) as Record<string, unknown>, null, 2);
    expect(verify(headerFor(), { body: reserialized })).toMatchObject({ ok: false });
  });

  it("tolerates an unknown extra field, so a future v2 does not break v1 receivers", () => {
    expect(verify(`${headerFor()},v2=whatever`)).toEqual({ ok: true });
  });
});
