// The body of a run-completion callback: built once when the run settles, stored, and re-sent
// verbatim on every retry.
//
// The shape is LangGraph's and does not change — this is delivery semantics, not a new payload. Two
// fields are supplied per *attempt* rather than stored: `status`, which comes from the delivery's
// `run_status` so the body can never contradict the run row, and `webhook_sent_at`, which describes
// the attempt rather than the run.

import type { Delivery, DefaultValues, Run } from "@skein-js/core";

import { DEFAULT_MAX_PAYLOAD_BYTES } from "./delivery-config.js";

/** What the truncation marker replaces `values` with, inside the signed body. */
export interface TruncatedValues {
  $skein_truncated: true;
  reason: string;
  bytes: number;
}

export interface BuildDeliveryPayloadInput {
  run: Run;
  values: DefaultValues;
  runStartedAt: string;
  runEndedAt: string;
  /** The failure message, for a run that failed. Matches LangGraph: a plain string, not a `RunError`. */
  error?: string;
  maxPayloadBytes?: number;
}

export interface BuiltDeliveryPayload {
  payload: Record<string, unknown>;
  truncated: boolean;
  /** The serialized size of the untruncated body, for the log line and the marker. */
  bytes: number;
}

/**
 * Build the stored half of a delivery body, replacing `values` with a marker when the whole thing
 * would exceed `maxPayloadBytes`.
 *
 * The marker goes **inside** the body rather than in a header, so a receiver cannot be misled about
 * having the run's whole final state — a header is easy to ignore and a truncated `values` is
 * indistinguishable from a genuinely small one. `values` is the only field replaced because it is the
 * only unbounded one; the rest of the row is fixed-size metadata the receiver needs to act at all.
 */
export function buildDeliveryPayload(input: BuildDeliveryPayloadInput): BuiltDeliveryPayload {
  const { status: _replaced, ...run } = input.run;
  const payload: Record<string, unknown> = {
    ...run,
    values: input.values,
    run_started_at: input.runStartedAt,
    run_ended_at: input.runEndedAt,
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
  const cap = input.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const bytes = byteLength(JSON.stringify(payload));
  if (bytes <= cap) return { payload, truncated: false, bytes };
  const marker: TruncatedValues = {
    $skein_truncated: true,
    reason: `values omitted: the delivery body was ${bytes} bytes, over the ${cap}-byte cap`,
    bytes,
  };
  return { payload: { ...payload, values: marker }, truncated: true, bytes };
}

/**
 * The body to actually send on this attempt: the stored payload, plus the two fields that are a
 * property of the attempt rather than of the run.
 */
export function toDeliveryBody(delivery: Delivery, sentAt: string): Record<string, unknown> {
  return {
    ...(delivery.payload as Record<string, unknown>),
    // From the delivery row, never from the stored body: this is the status the finalize transaction
    // actually committed, so a callback cannot disagree with the run a receiver reads back after it.
    status: delivery.run_status,
    webhook_sent_at: sentAt,
  };
}

/** UTF-8 byte length, since the cap is on bytes over the wire rather than on JS string length. */
function byteLength(text: string): number {
  return typeof TextEncoder === "undefined" ? text.length : new TextEncoder().encode(text).length;
}
