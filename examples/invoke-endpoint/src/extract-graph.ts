// A second non-chat graph, so the example shows the "one endpoint per graph" mapping: every id in the
// graph map becomes its own `POST /invoke/<id>`. Pulls contact details out of free text.

import { Annotation, StateGraph, type CompiledGraph } from "@langchain/langgraph";

const ExtractState = Annotation.Root({
  text: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  emails: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
  urls: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
});

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

/** De-duplicate while preserving first-seen order. */
const unique = (values: string[]): string[] => [...new Set(values)];

export const graph: CompiledGraph<string> = new StateGraph(ExtractState)
  .addNode("extract", (state: typeof ExtractState.State) => ({
    emails: unique(state.text.match(EMAIL_PATTERN) ?? []),
    urls: unique(state.text.match(URL_PATTERN) ?? []),
  }))
  .addEdge("__start__", "extract")
  .addEdge("extract", "__end__")
  .compile() as unknown as CompiledGraph<string>;
