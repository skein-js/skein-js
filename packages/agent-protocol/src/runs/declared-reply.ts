// A graph declaring what should be sent back to whoever started the run.
//
// The problem this solves is a coupling one. Anything delivering a run's answer to the outside world —
// a chat channel, a notification, an email — has to turn the run into a message, and only two parties
// could decide how: the deliverer, or the graph. The deliverer would have to know the graph's state
// shape (`state.answer`? `state.messages.at(-1)`? `state.draft`?), which stops it being reusable across
// graphs. So the graph declares it instead, on the stream it already has.
//
// It rides the **custom stream** (`stream_mode: "custom"`, LangGraph's `StreamWriter`) rather than
// graph state, because it is a message about the run, not part of the run's state — putting it in state
// would make it a channel every reducer and checkpoint carries forever.
//
// Captured into the delivery payload rather than read off the event bus at delivery time, because the
// bus is in-memory and frames are never persisted: a receiver reading it there would lose the answer on
// a crash, which is exactly the guarantee the delivery outbox exists to provide.

/** The reserved key a graph writes to declare its reply. Namespaced so it cannot collide. */
export const DECLARED_REPLY_KEY = "$skein_reply";

/**
 * Declare the reply for this run, from inside a node.
 *
 * ```ts
 * import { replyWith } from "@skein-js/agent-protocol";
 * // inside a node, with a StreamWriter in scope
 * writer(replyWith("Your order ships Tuesday."));
 * ```
 *
 * Last write wins: a run has one answer, and a graph that writes twice meant the second one.
 */
export function replyWith(reply: unknown): Record<string, unknown> {
  return { [DECLARED_REPLY_KEY]: reply };
}

/**
 * The declared reply carried by a custom-stream payload, or `undefined` if this frame is not one.
 *
 * Deliberately narrow: only an object whose *own* reserved key is present counts, so a graph streaming
 * ordinary custom data is never mistaken for one declaring a reply.
 */
export function readDeclaredReply(data: unknown): { reply: unknown } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  if (!Object.prototype.hasOwnProperty.call(data, DECLARED_REPLY_KEY)) return undefined;
  return { reply: (data as Record<string, unknown>)[DECLARED_REPLY_KEY] };
}
