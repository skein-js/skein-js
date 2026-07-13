// Fixtures for loadGraph: the various export shapes a real langgraph.json entry can point at.
// Exports are typed `unknown` on purpose — loadGraph inspects the real runtime object, and the
// concrete graph types aren't nameable from here (they reach into @langchain/core), which would
// trip declaration-portability under `declaration: true`. Type info is irrelevant for fixtures.
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";

const builder = new StateGraph(MessagesAnnotation)
  .addNode("noop", () => ({}))
  .addEdge("__start__", "noop")
  .addEdge("noop", "__end__");

/** A compiled graph export. */
export const compiled: unknown = builder.compile();

/** An UNcompiled builder export — loadGraph must compile it (like the LangGraph CLI does). */
export const uncompiled: unknown = builder;

/** A factory export — loadGraph must return it un-invoked so config can be applied per run. */
export const factory = (): unknown => builder.compile();

/** An explicit null export — loadGraph must reject, not pass it through. */
export const nothing = null;

/** A default export, exercising the `exportSymbol || "default"` fallback. */
const defaultGraph: unknown = builder.compile();
// This fixture must have a real default export precisely to test that resolution path.
// eslint-disable-next-line import/no-default-export
export default defaultGraph;
