// Turning a settled run into the thing a channel should send.

import type { Interrupt, RunStatus } from "@skein-js/core";

import type { RunOutcomeForChannel } from "../channel/channel.js";

/** The callback body the delivery outbox stores and replays. */
export interface DeliveryPayload {
  run_id?: string;
  thread_id?: string;
  status?: RunStatus;
  values?: unknown;
  interrupts?: Record<string, Interrupt[]>;
  reply?: unknown;
}

/**
 * Resolve what to send, in order:
 *
 * 1. **The reply the graph declared** via `replyWith`. Explicit beats inferred, and it is the only
 *    option that works for a graph whose state is not message-shaped.
 * 2. **The last AI message** in `values.messages`. This is `MessagesAnnotation`'s convention, so an
 *    ordinary chat agent works with *no graph changes at all* — which is the point of making it a
 *    fallback rather than the contract.
 * 3. **Nothing.**
 *
 * Resolved here rather than in each channel, because the alternative is every channel knowing the
 * graph's state shape — and a channel that guesses at `state.answer` versus `state.draft` stops being
 * reusable across graphs, which breaks the whole plugin premise.
 */
export function resolveReply(payload: DeliveryPayload): unknown {
  if (payload.reply !== undefined) return payload.reply;
  if (payload.status === "interrupted") return renderInterrupt(payload.interrupts);
  // Deliberately only on success. Whether an end user is told "something went wrong" is a product
  // decision, and leaking a failed run's internals to a phone number is the wrong default — so an
  // `error`, `timeout` or `cancelled` run says nothing unless the graph declared something first.
  if (payload.status !== "success") return undefined;
  return lastAiMessage(payload.values);
}

/**
 * The question an interrupted run is waiting on.
 *
 * Available at all only because the callback now carries `interrupts` — before that a receiver had to
 * make a second round trip to the thread, and skipping it stranded the conversation permanently.
 */
function renderInterrupt(interrupts: Record<string, Interrupt[]> | undefined): unknown {
  for (const raised of Object.values(interrupts ?? {})) {
    const first = raised[0];
    if (first && first.value !== undefined) return first.value;
  }
  return undefined;
}

/** The last AI message's content, for a state carrying LangGraph's `messages` channel. */
function lastAiMessage(values: unknown): unknown {
  const messages = (values as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { type?: string; role?: string; content?: unknown } | null;
    if (!message) continue;
    // Both shapes: LangChain messages serialize with `type`, while a plain object written by a graph
    // author usually carries `role`. A receiver should not have to care which one the graph produced.
    const kind = message.type ?? message.role;
    if (kind === "ai" || kind === "assistant") return message.content;
  }
  return undefined;
}

/** The settled run, as a channel's `deliver` sees it. */
export function toRunOutcome(payload: DeliveryPayload): RunOutcomeForChannel {
  const reply = resolveReply(payload);
  return {
    runId: payload.run_id ?? "",
    threadId: payload.thread_id ?? "",
    status: (payload.status ?? "success") as RunStatus,
    ...(reply !== undefined ? { reply } : {}),
    ...(payload.interrupts ? { interrupts: payload.interrupts } : {}),
    ...(payload.values !== undefined ? { values: payload.values } : {}),
  };
}
