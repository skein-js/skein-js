// Turning stored deliveries and raw payloads into wire requests with headers and signatures.

import type { Delivery } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { verifySkeinSignature } from "../crypto/verify-delivery.js";

import {
  createDeliveryRequest,
  toDeliveryRequest,
  toDeliveryRequestFromPayload,
} from "./delivery-request.js";

describe("delivery-request", () => {
  const sentAt = new Date("2026-01-01T12:00:00.000Z");
  const payload = { run_id: "run-1", status: "success", values: { count: 1 } };

  it("builds an unsigned request from payload when no secret is configured", () => {
    const request = toDeliveryRequestFromPayload({
      deliveryId: "del-123",
      attempt: 1,
      sentAt,
      payload,
    });

    expect(request.payload).toBe(payload);
    expect(request.attempt).toEqual({
      deliveryId: "del-123",
      attempt: 1,
      headers: {
        "x-skein-delivery-id": "del-123",
        "x-skein-attempt": "1",
      },
      body: JSON.stringify(payload),
    });
  });

  it("signs the payload with the first secret", () => {
    const secret = "whsec_test_secret";
    const request = toDeliveryRequestFromPayload({
      deliveryId: "del-123",
      attempt: 2,
      sentAt,
      payload,
      secrets: [secret, "whsec_secondary"],
    });

    expect(request.attempt.headers["x-skein-delivery-id"]).toBe("del-123");
    expect(request.attempt.headers["x-skein-attempt"]).toBe("2");
    expect(request.attempt.headers["x-skein-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const verification = verifySkeinSignature({
      header: request.attempt.headers["x-skein-signature"],
      body: request.attempt.body,
      secrets: [secret],
      nowSeconds: Math.floor(sentAt.getTime() / 1000),
    });
    expect(verification).toEqual({ ok: true });
  });

  it("builds a request from a stored Delivery object", () => {
    const delivery: Delivery = {
      delivery_id: "del-stored",
      run_id: "run-1",
      thread_id: "thread-1",
      url: "https://example.test/webhook",
      payload: { run_id: "run-1", values: { ok: true } },
      payload_truncated: false,
      last_error: null,
      run_status: "success",
      status: "pending",
      attempt: 1,
      next_attempt_at: "2026-01-01T12:00:00.000Z",
      expires_at: "2026-01-02T12:00:00.000Z",
      created_at: "2026-01-01T12:00:00.000Z",
      updated_at: "2026-01-01T12:00:00.000Z",
    };

    const request = toDeliveryRequest({
      delivery,
      attempt: 1,
      sentAt,
    });

    expect(request.payload).toEqual({
      run_id: "run-1",
      values: { ok: true },
      status: "success",
      webhook_sent_at: sentAt.toISOString(),
    });
    expect(request.attempt.deliveryId).toBe("del-stored");
    expect(request.attempt.attempt).toBe(1);
    expect(request.attempt.headers["x-skein-delivery-id"]).toBe("del-stored");
    expect(request.attempt.headers["x-skein-attempt"]).toBe("1");
  });

  it("createDeliveryRequest behaves identically to toDeliveryRequestFromPayload", () => {
    expect(createDeliveryRequest).toBe(toDeliveryRequestFromPayload);
  });
});
