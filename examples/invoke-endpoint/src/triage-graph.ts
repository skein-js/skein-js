// A deliberately non-chat graph: classify a support ticket. No messages, no model, no API key — the
// point is that plenty of LangGraph work is plain data in / data out, and that shape wants a plain
// HTTP endpoint rather than threads and runs.

import { Annotation, StateGraph, type CompiledGraph } from "@langchain/langgraph";

const TicketState = Annotation.Root({
  text: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  category: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  priority: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
});

const CATEGORY_KEYWORDS: Array<[category: string, keywords: string[]]> = [
  ["billing", ["invoice", "charge", "refund", "payment", "billing"]],
  ["bug", ["error", "crash", "broken", "fails", "exception", "bug"]],
  ["account", ["login", "password", "sign in", "account", "locked"]],
];

const URGENT_KEYWORDS = ["urgent", "asap", "immediately", "outage", "down", "critical"];

/** Route the ticket to a queue by keyword, defaulting to `general`. */
function classify(state: typeof TicketState.State): { category: string } {
  const text = state.text.toLowerCase();
  const hit = CATEGORY_KEYWORDS.find(([, keywords]) => keywords.some((k) => text.includes(k)));
  return { category: hit?.[0] ?? "general" };
}

/** A billing or bug ticket that also sounds urgent gets escalated. */
function prioritize(state: typeof TicketState.State): { priority: string } {
  const text = state.text.toLowerCase();
  const urgent = URGENT_KEYWORDS.some((k) => text.includes(k));
  if (urgent && (state.category === "bug" || state.category === "billing")) {
    return { priority: "P1" };
  }
  return { priority: urgent ? "P2" : "P3" };
}

export const graph: CompiledGraph<string> = new StateGraph(TicketState)
  .addNode("classify", classify)
  .addNode("prioritize", prioritize)
  .addEdge("__start__", "classify")
  .addEdge("classify", "prioritize")
  .addEdge("prioritize", "__end__")
  .compile() as unknown as CompiledGraph<string>;
