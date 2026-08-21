// The agent behind the phone number: a small support bot that stops and asks before it does anything
// irreversible.
//
//   START → understand ─┬→ respond ──────────────→ END
//                       └→ confirm → respond ────→ END
//
// The branch is the whole reason this example exists. A refund request parks on `interrupt()`, the run
// settles, and the process can restart — the thread waits. When the customer texts back "yes" an hour
// later, that message resumes the *same* interrupt rather than starting a new conversation. That is
// human-in-the-loop where the human is the end user and the channel is asynchronous, which is the case
// browser-shaped HITL never has to handle.
//
// Offline and deterministic: no API key, no model call, no network. The rules are obviously toy ones.
// What is *not* toy is the shape — a graph that interrupts, and a `messages` channel — because those
// are what the inbound plumbing in the rest of this example has to cope with.

import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import {
  Annotation,
  END,
  getStore,
  interrupt,
  type LangGraphRunnableConfig,
  messagesStateReducer,
  START,
  StateGraph,
} from "@langchain/langgraph";

const SupportState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  /** What the customer asked for that needs confirming, if anything. */
  pendingAction: Annotation<string | undefined>({
    reducer: (_, next) => next,
    default: () => undefined,
  }),
  /** Whether they confirmed it. `false` means they said no and nothing happens. */
  confirmed: Annotation<boolean | undefined>({
    reducer: (_, next) => next,
    default: () => undefined,
  }),
  /** True once we have heard from this customer before — read from the long-term store. */
  returning: Annotation<boolean | undefined>({
    reducer: (_, next) => next,
    default: () => undefined,
  }),
});

type State = typeof SupportState.State;

/** Anything that moves money or cancels something — the class of request worth a second question. */
const IRREVERSIBLE = /\b(refund|cancel|delete|close my account)\b/i;

/** The text of the most recent human turn. */
function lastMessageText(messages: readonly BaseMessage[]): string {
  const last = messages.at(-1);
  if (!last) return "";
  return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
}

/**
 * Remember something about this customer that outlives the conversation.
 *
 * Two kinds of memory are in play here and they are easy to confuse. The `messages` channel is
 * *within* a thread — it survives because the thread has a checkpoint, which is what makes a reply
 * hours later continue the same conversation. This node is the other kind: the long-term store, keyed
 * by the customer, so what they told you in March is still there in June under a different thread.
 *
 * `getStore()` reaches the store skein injected into the run — no wiring in this file.
 */
async function remember(state: State, config: LangGraphRunnableConfig): Promise<Partial<State>> {
  const store = getStore();
  const customer = (config.configurable?.["thread_id"] as string | undefined) ?? "unknown";
  const namespace = ["customers", customer];

  const seen = await store?.get(namespace, "profile");
  const turns = ((seen?.value?.["turns"] as number | undefined) ?? 0) + 1;
  const text = lastMessageText(state.messages);
  await store?.put(namespace, "profile", {
    turns,
    // The most recent thing they asked about, so a later conversation can refer back to it.
    lastTopic: text.slice(0, 120),
  });

  return { returning: turns > 1 };
}

function understand(state: State): Partial<State> {
  const text = lastMessageText(state.messages);
  const match = IRREVERSIBLE.exec(text);
  return { pendingAction: match ? match[0].toLowerCase() : undefined };
}

/**
 * Park until the customer answers.
 *
 * The value handed back is whatever resumed the run — here, the raw text of their next WhatsApp
 * message. The graph author is the only party who knows that "yes" means yes, which is why the
 * inbound route resumes with the message text verbatim and does no interpreting of its own.
 */
function confirm(state: State): Partial<State> {
  const answer = interrupt({
    question: `Just to confirm — you want to ${state.pendingAction}? Reply YES to go ahead.`,
    action: state.pendingAction,
  });
  const said = typeof answer === "string" ? answer : String(answer);
  return { confirmed: /^\s*(y|yes|yeah|yep|confirm|ok)\b/i.test(said) };
}

function respond(state: State): Partial<State> {
  return { messages: [new AIMessage(replyText(state))] };
}

function replyText(state: State): string {
  if (state.pendingAction === undefined) {
    const text = lastMessageText(state.messages);
    // The one visible effect of the long-term store: a customer who has written before is greeted as
    // one, even from a conversation that was archived months ago.
    const greeting = state.returning === true ? "Welcome back!" : "Hi!";
    return text.trim() === ""
      ? `${greeting} Ask me about an order, a refund, or your account.`
      : `${greeting} Thanks — I've noted: "${text}". Someone will follow up shortly.`;
  }
  return state.confirmed === true
    ? `Done — your ${state.pendingAction} is being processed. You'll get a confirmation shortly.`
    : "No problem — I haven't made any changes.";
}

/** Irreversible requests stop and ask; everything else answers straight away. */
function needsConfirmation(state: State): "confirm" | "respond" {
  return state.pendingAction === undefined ? "respond" : "confirm";
}

export const graph = new StateGraph(SupportState)
  .addNode("remember", remember)
  .addNode("understand", understand)
  .addNode("confirm", confirm)
  .addNode("respond", respond)
  .addEdge(START, "remember")
  .addEdge("remember", "understand")
  .addConditionalEdges("understand", needsConfirmation, ["confirm", "respond"])
  .addEdge("confirm", "respond")
  .addEdge("respond", END)
  .compile();
