// The body of a run-completion callback: built once when the run settles, stored, and re-sent
// verbatim on every retry.
//
// The shape is LangGraph's and does not change — this is delivery semantics, not a new payload. Two
// fields are supplied per *attempt* rather than stored: `status`, which comes from the delivery's
// `run_status` so the body can never contradict the run row, and `webhook_sent_at`, which describes
// the attempt rather than the run.

import type { Delivery, DefaultValues, Interrupt, Run } from "@skein-js/core";

import { DEFAULT_MAX_PAYLOAD_BYTES } from "./delivery-config.js";

/** What the truncation marker replaces an over-cap field with, inside the signed body. */
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
  /**
   * The questions the run is waiting on, keyed by task — the thread snapshot's pending interrupts, in
   * the same shape the wire `Thread.interrupts` carries.
   *
   * Only ever present on an `interrupted` run, so a successful run's body is byte-identical to what it
   * was before this field existed. It is here because it is otherwise **unreachable from a callback**:
   * `values` is the graph's state, and an `interrupt()` payload is not part of it. A receiver that only
   * has the callback could not render the question at all, and a conversation whose question is never
   * asked waits forever.
   */
  interrupts?: Record<string, Interrupt[]>;
  /**
   * What the graph declared should be sent back, via `replyWith` on the custom stream.
   *
   * Present only when the graph actually declared one, so nothing changes for a graph that does not.
   * It is here rather than left on the event bus because bus frames are never persisted: a receiver
   * reading the reply from the stream would lose it on a crash, and the callback is the only thing
   * that survives one.
   */
  reply?: unknown;
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
 * indistinguishable from a genuinely small one. `values` and `interrupts` are the only fields replaced
 * because they are the only unbounded ones; the rest of the row is fixed-size metadata the receiver
 * needs to act at all. When both are present `values` is dropped first — see the ordering note below.
 */
export function buildDeliveryPayload(input: BuildDeliveryPayloadInput): BuiltDeliveryPayload {
  const { status: _replaced, ...run } = input.run;
  const hasInterrupts = input.interrupts !== undefined && Object.keys(input.interrupts).length > 0;
  const payload: Record<string, unknown> = {
    ...run,
    values: input.values,
    run_started_at: input.runStartedAt,
    run_ended_at: input.runEndedAt,
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(hasInterrupts ? { interrupts: input.interrupts } : {}),
    ...(input.reply !== undefined ? { reply: input.reply } : {}),
  };
  const cap = input.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const bytes = byteLength(JSON.stringify(payload));
  if (bytes <= cap) return { payload, truncated: false, bytes };

  // `values` is sacrificed first, and `interrupts` only if the body is still over the cap afterwards.
  // The order is the whole point: `interrupts` is now the second unbounded field, but it is also the
  // one an interrupted run cannot be acted on without. Dropping the question to keep the state would
  // strand exactly the conversations this field exists to unstrand, so state goes first.
  const truncatedValues = { ...payload, values: marker("values", bytes, cap) };
  const afterValues = byteLength(JSON.stringify(truncatedValues));
  if (!hasInterrupts || afterValues <= cap) {
    return { payload: truncatedValues, truncated: true, bytes };
  }
  return {
    payload: { ...truncatedValues, interrupts: marker("interrupts", bytes, cap) },
    truncated: true,
    bytes,
  };
}

/** The stand-in for a field too large to send, carrying why and how big the whole body was. */
function marker(field: string, bytes: number, cap: number): TruncatedValues {
  return {
    $skein_truncated: true,
    reason: `${field} omitted: the delivery body was ${bytes} bytes, over the ${cap}-byte cap`,
    bytes,
  };
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
