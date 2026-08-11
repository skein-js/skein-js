// Turning a stored delivery into the request that goes on the wire: the body, serialized exactly
// once, and the headers that describe and sign it.
//
// One function rather than two, because the inline attempt and the queue-driven one must produce
// byte-identical requests. The way they would diverge is a signature computed over one serialization
// and a body sent from another — which fails only on the receiving end, only for some payloads, and
// looks like a key problem rather than a serialization one.

import type { Delivery } from "@skein-js/core";

import { signDelivery } from "../crypto/sign-delivery.js";
import { deliveryHeaders, type DeliveryAttempt } from "../deps.js";

import { toDeliveryBody } from "./delivery-payload.js";

export interface DeliveryRequest {
  /** The parsed body, for a dispatcher that would rather have the object. */
  payload: Record<string, unknown>;
  /** Ids, attempt number, signature, and the exact bytes they describe. */
  attempt: DeliveryAttempt;
}

export function toDeliveryRequest(input: {
  delivery: Delivery;
  /** Which attempt this is, counting the engine's inline one as the first. */
  attempt: number;
  sentAt: Date;
  /** Signing keys; the first signs. Empty or absent means an unsigned callback. */
  secrets?: readonly string[];
}): DeliveryRequest {
  const payload = toDeliveryBody(input.delivery, input.sentAt.toISOString());
  // Serialized once, here, and carried through to the dispatcher. Everything downstream sends these
  // bytes rather than re-deriving them.
  const body = JSON.stringify(payload);
  const [signingKey] = input.secrets ?? [];
  const signature = signingKey
    ? signDelivery({
        secret: signingKey,
        // Whole seconds, matching the format: the receiver parses `t` as unix seconds, and a
        // fractional value would not survive the round trip into its own tolerance check.
        timestampSeconds: Math.floor(input.sentAt.getTime() / 1000),
        body,
      })
    : undefined;
  return {
    payload,
    attempt: {
      deliveryId: input.delivery.delivery_id,
      attempt: input.attempt,
      headers: deliveryHeaders(input.delivery.delivery_id, input.attempt, signature),
      body,
    },
  };
}
