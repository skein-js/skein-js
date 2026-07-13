import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";

/**
 * A deterministic, zero-setup graph: it echoes the last human message back.
 * No API key, no network — the perfect thing to point a client at while wiring up skein-js.
 */
function echo(state: typeof MessagesAnnotation.State): { messages: BaseMessage[] } {
  const last = state.messages.at(-1);
  const text = typeof last?.content === "string" ? last.content : "";
  return { messages: [new AIMessage(`echo: ${text}`)] };
}

export const graph = new StateGraph(MessagesAnnotation)
  .addNode("echo", echo)
  .addEdge("__start__", "echo")
  .addEdge("echo", "__end__")
  .compile();
