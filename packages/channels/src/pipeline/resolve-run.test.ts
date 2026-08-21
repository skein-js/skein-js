// Whether an inbound message starts a turn or answers the question already on the thread.
//
// This is the decision the proposal called "the one everybody gets wrong", and the reason is that
// nothing else in the system catches it: `interrupted` is a *terminal* run status, so a thread
// waiting on a human holds no inflight run and every `multitask_strategy` lets a fresh start through.

import { describe, expect, it } from "vitest";

import type { InboundEvent } from "../channel/channel.js";

import { resolveRunPlan } from "./resolve-run.js";

const event = (overrides: Partial<InboundEvent> = {}): InboundEvent => ({
  threadKey: "whatsapp:+254712345678",
  input: "yes",
  ...overrides,
});

const depsWith = (status: "idle" | "busy" | "interrupted" | "error" | null) => ({
  threadStatus: async () => status,
});

describe("resolveRunPlan", () => {
  it("resumes an interrupted thread by default", async () => {
    // A reply arriving hours after `interrupt()` is an *answer*, not a new conversation. Getting this
    // wrong discards the pending question with no error anywhere.
    const plan = await resolveRunPlan(event(), "t", depsWith("interrupted"));

    expect(plan.run.command).toEqual({ resume: "yes" });
    expect(plan.run.input).toBeUndefined();
  });

  it("resumes with the input verbatim, coercing nothing", async () => {
    // The graph author wrote `interrupt()` and is the only party who knows whether that node wants
    // `true`, `"approve"`, or free text. Interpreting here would be guessing on their behalf.
    const plan = await resolveRunPlan(
      event({ input: { approved: false } }),
      "t",
      depsWith("interrupted"),
    );

    expect(plan.run.command).toEqual({ resume: { approved: false } });
  });

  it("guards the resume on the thread still being interrupted", async () => {
    // The read and the create are not atomic with each other — someone could answer from the console
    // between them. The precondition is what makes the decision safe; the read only chooses which
    // request to send.
    const plan = await resolveRunPlan(event(), "t", depsWith("interrupted"));

    expect(plan.run.ifThreadStatus).toEqual(["interrupted"]);
  });

  it("starts a fresh turn on an idle thread", async () => {
    const plan = await resolveRunPlan(event(), "t", depsWith("idle"));

    expect(plan.run.input).toBe("yes");
    expect(plan.run.command).toBeUndefined();
  });

  it("guards a fresh start so a thread that just became interrupted is not trampled", async () => {
    // The race in the other direction: a question that arrived microseconds ago must not be silently
    // discarded by a start that read `idle`.
    const plan = await resolveRunPlan(event(), "t", depsWith("idle"));

    expect(plan.run.ifThreadStatus).not.toContain("interrupted");
  });

  it("starts on a thread that does not exist yet", async () => {
    // A first message costs no special case.
    const plan = await resolveRunPlan(event(), "t", depsWith(null));

    expect(plan.run.input).toBe("yes");
  });

  it("lets a channel refuse rather than resume", async () => {
    // "A message on an interrupted thread is an answer" is true for WhatsApp and false for a Stripe
    // event, so the channel decides.
    const plan = await resolveRunPlan(
      event({ onExisting: "reject" }),
      "t",
      depsWith("interrupted"),
    );

    expect(plan.run.command).toBeUndefined();
    expect(plan.run.ifThreadStatus).toEqual(["idle", "error"]);
  });

  it("maps enqueue and interrupt onto the multitask strategy, with no status guard", async () => {
    // These policies mean "treat it as its own turn regardless" — a status precondition would refuse
    // creates they exist to accept.
    for (const policy of ["enqueue", "interrupt"] as const) {
      const plan = await resolveRunPlan(event({ onExisting: policy }), "t", depsWith("busy"));
      expect(plan.run.multitaskStrategy).toBe(policy);
      expect(plan.run.ifThreadStatus).toBeUndefined();
    }
  });

  it("does not read the thread when the policy does not depend on it", async () => {
    // `enqueue` and `interrupt` are decided by the strategy alone, so the round trip is waste.
    let reads = 0;
    await resolveRunPlan(event({ onExisting: "enqueue" }), "t", {
      threadStatus: async () => {
        reads += 1;
        return "idle";
      },
    });

    expect(reads).toBe(0);
  });
});
