import { Annotation, StateGraph, interrupt } from "@langchain/langgraph";

const approval = Annotation.Root({ request: Annotation<string>, decision: Annotation<string> });

/** Application policy lives in the graph; every transport uses this same graph. */
export const approvalGraph = new StateGraph(approval)
  .addNode("approve", (state) => ({
    decision:
      interrupt({ question: "Approve this request?", request: state.request }) === "approve"
        ? "approved"
        : "rejected",
  }))
  .addEdge("__start__", "approve")
  .addEdge("approve", "__end__")
  .compile();
