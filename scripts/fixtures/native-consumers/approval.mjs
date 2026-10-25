import { Annotation, StateGraph, interrupt } from "@langchain/langgraph";

export function approvalGraph(onExecute = () => {}) {
  const state = Annotation.Root({ answer: Annotation() });
  return new StateGraph(state)
    .addNode("approve", async () => {
      onExecute();
      return {
        answer: interrupt("approve?") === "approve" ? "approved ".repeat(2000) : "rejected",
      };
    })
    .addEdge("__start__", "approve")
    .addEdge("approve", "__end__")
    .compile();
}
