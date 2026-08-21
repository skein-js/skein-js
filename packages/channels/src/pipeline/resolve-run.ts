// Start a new turn, or answer the question the thread is already waiting on.

import type { Metadata } from "@skein-js/core";

import type { InboundEvent } from "../channel/channel.js";

type ThreadStatus = "idle" | "busy" | "interrupted" | "error";

/** What the pipeline needs to decide the branch. */
export interface RunPlanDeps {
  threadStatus(threadId: string): Promise<ThreadStatus | null>;
}

export interface RunPlan {
  run: {
    input?: unknown;
    command?: { resume?: unknown };
    ifThreadStatus?: readonly ThreadStatus[];
    multitaskStrategy?: "reject" | "interrupt" | "rollback" | "enqueue";
    metadata?: Metadata;
  };
}

/**
 * Decide how this event joins the conversation already in progress, if any.
 *
 * **The default is `resume`, and that is the single most valuable decision in this package.** A reply
 * arriving hours after an `interrupt()` is an *answer*, not a new conversation. Starting a fresh run
 * instead discards the pending question — and because `interrupted` is a terminal run status, nothing
 * else in the system stops it: the thread holds no inflight run, so every `multitask_strategy` lets
 * the start through, silently.
 *
 * The decision is expressed as a **precondition on the create** rather than acted on here, so it is
 * settled atomically inside the driver. Reading the status and then creating would be a read and a
 * write with an `await` between them — two replicas both see `interrupted`, both resume, and the
 * graph gets two answers to one question. The status read below is only for choosing *which* request
 * to make; the request itself carries the guard that makes it correct.
 */
export async function resolveRunPlan(
  event: InboundEvent,
  threadId: string,
  deps: RunPlanDeps,
): Promise<RunPlan> {
  const policy = event.onExisting ?? "resume";
  const metadata = event.metadata as Metadata | undefined;
  const base = metadata ? { metadata } : {};

  if (policy === "enqueue" || policy === "interrupt") {
    // The caller wants the new message treated as its own turn regardless. No status precondition:
    // the multitask strategy is the whole policy, and adding a guard would refuse creates it is
    // meant to accept.
    return { run: { ...base, input: event.input, multitaskStrategy: policy } };
  }

  const status = await deps.threadStatus(threadId);

  if (policy === "reject") {
    // Only start on a thread that is genuinely free. The precondition is what enforces it; the read
    // above just avoids sending a request that is certain to 409.
    return { run: { ...base, input: event.input, ifThreadStatus: ["idle", "error"] } };
  }

  if (status === "interrupted") {
    // The message answers the pending question. Resumed **verbatim** — the graph author wrote
    // `interrupt()` and is the only party who knows whether that node wants `true`, `"approve"`, or
    // free text, so coercing here would be guessing on their behalf. A channel that needs the resume
    // value to differ from its graph input says so with `resumeWith`; see `InboundEvent`.
    //
    // Guarded on `interrupted`: if the thread moved on between the read and the create — someone
    // answered from the console, a cron fired — this 409s rather than resuming an interrupt that is
    // no longer there.
    const resume = event.resumeWith !== undefined ? event.resumeWith : event.input;
    return { run: { ...base, command: { resume }, ifThreadStatus: ["interrupted"] } };
  }

  // A fresh turn, and it **enqueues**.
  //
  // The server's default `multitask_strategy` is `reject`, which would answer 422 when a customer
  // sends a second message while the agent is still thinking — and for Twilio that renders as a failed
  // message for having typed twice. A conversation wants ordering, not rejection.
  //
  // The status read above cannot be used to detect that case, which is worth knowing: a run that is
  // still `pending` holds the thread but has not yet been mirrored onto the thread row, so the status
  // reads `idle` while a create would be refused. `enqueue` is correct either way.
  //
  // Still guarded, so a thread that becomes `interrupted` between the read and the create is not
  // trampled — the caller gets a 409 and re-resolves rather than silently discarding a question that
  // arrived microseconds ago.
  return {
    run: {
      ...base,
      input: event.input,
      multitaskStrategy: "enqueue",
      ifThreadStatus: ["idle", "error", "busy"],
    },
  };
}
