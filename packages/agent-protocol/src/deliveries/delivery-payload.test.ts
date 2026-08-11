// The callback body: what is stored once, and what is supplied per attempt.

import type { Delivery, DefaultValues, Run } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { buildDeliveryPayload, toDeliveryBody } from "./delivery-payload.js";

const run: Run = {
  run_id: "run-1",
  thread_id: "thread-1",
  assistant_id: "assistant-1",
  status: "running",
  metadata: { tenant: "acme" },
  multitask_strategy: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:01.000Z",
} as Run;

const built = (overrides: Partial<Parameters<typeof buildDeliveryPayload>[0]> = {}) =>
  buildDeliveryPayload({
    run,
    values: { answer: 42 } as unknown as DefaultValues,
    runStartedAt: "2026-01-01T00:00:00.000Z",
    runEndedAt: "2026-01-01T00:00:05.000Z",
    ...overrides,
  });

const deliveryOf = (payload: unknown, runStatus: Delivery["run_status"] = "success"): Delivery =>
  ({ payload, run_status: runStatus }) as Delivery;

describe("delivery payload", () => {
  it("carries the run row, its final values and the run timestamps", () => {
    const { payload, truncated } = built();

    expect(truncated).toBe(false);
    expect(payload).toMatchObject({
      run_id: "run-1",
      thread_id: "thread-1",
      assistant_id: "assistant-1",
      metadata: { tenant: "acme" },
      values: { answer: 42 },
      run_started_at: "2026-01-01T00:00:00.000Z",
      run_ended_at: "2026-01-01T00:00:05.000Z",
    });
  });

  it("stores no status of its own", () => {
    // The run row's status at build time is `running` — the terminal one is not known until the
    // transaction commits. Storing it here would bake in a value the driver is about to contradict.
    expect(built().payload).not.toHaveProperty("status");
  });

  it("carries the failure message as a plain string, matching LangGraph", () => {
    expect(built({ error: "boom" }).payload).toMatchObject({ error: "boom" });
  });

  it("omits `error` entirely for a run that did not fail", () => {
    expect(built().payload).not.toHaveProperty("error");
  });

  it("replaces oversized values with a marker inside the body, not a header", () => {
    // Inside the body deliberately: a header is easy to ignore, and a truncated `values` is otherwise
    // indistinguishable from a genuinely small one. A receiver must not be able to mistake one for
    // the other — this is the field they act on.
    const values = { blob: "x".repeat(2_000) } as unknown as DefaultValues;
    const { payload, truncated, bytes } = built({ values, maxPayloadBytes: 500 });

    expect(truncated).toBe(true);
    expect(bytes).toBeGreaterThan(500);
    expect(payload["values"]).toMatchObject({ $skein_truncated: true, bytes });
    // Everything the receiver needs to go and fetch the state for itself survives.
    expect(payload).toMatchObject({ run_id: "run-1", thread_id: "thread-1" });
  });

  it("truncates only `values` — the rest of the row is what makes the callback actionable", () => {
    const values = { blob: "x".repeat(2_000) } as unknown as DefaultValues;
    const { payload } = built({ values, maxPayloadBytes: 500, error: "boom" });

    expect(payload).toMatchObject({ error: "boom", run_ended_at: "2026-01-01T00:00:05.000Z" });
  });

  it("leaves a body under the cap byte-identical to an unbounded one", () => {
    // The cap must be invisible to every deployment it does not bind on, or it is a payload change
    // rather than a bound.
    expect(built({ maxPayloadBytes: 1_000_000 }).payload).toEqual(built().payload);
  });

  it("measures the cap in UTF-8 bytes, not JS string length", () => {
    // A multi-byte value that fits by `.length` and does not fit on the wire is exactly the case that
    // would blow a column bound in production while passing every test written against `.length`.
    const values = { text: "é".repeat(400) } as unknown as DefaultValues;
    expect(built({ values, maxPayloadBytes: 700 }).truncated).toBe(true);
  });

  it("supplies the status from the delivery row, so the body cannot contradict the run", () => {
    // The engine asked for `success`; a cancel won the race and the driver stamped `cancelled`. The
    // receiver has to be told what `GET /runs/{id}` will tell them a millisecond later.
    const body = toDeliveryBody(
      deliveryOf(built().payload, "cancelled"),
      "2026-01-01T00:00:06.000Z",
    );

    expect(body["status"]).toBe("cancelled");
  });

  it("stamps the send time per attempt rather than storing it", () => {
    const delivery = deliveryOf(built().payload);

    expect(toDeliveryBody(delivery, "2026-01-01T00:00:06.000Z")["webhook_sent_at"]).toBe(
      "2026-01-01T00:00:06.000Z",
    );
    // A retry an hour later reports when *it* was sent — the field describes the attempt, and a
    // stored one would tell a receiver the retry happened at the moment the run finished.
    expect(toDeliveryBody(delivery, "2026-01-01T01:00:00.000Z")["webhook_sent_at"]).toBe(
      "2026-01-01T01:00:00.000Z",
    );
  });
});
