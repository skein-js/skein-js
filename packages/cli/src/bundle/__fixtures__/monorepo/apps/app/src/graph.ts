import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";

// Reached through the `@fixture/lib` tsconfig-path alias — proves the build inlines workspace-aliased
// source (used in the node body, not the state type, so schema extraction stays alias-independent).
import { banner } from "@fixture/lib";

// A published-shaped package installed next to the app and named nowhere in `langgraph.json`. Its
// only route into the artifact's `package.json` is the bundler's externals recorder, so this import
// is what proves that recorder runs at all — see the `enforce` note in bundle-project.ts.
import { marker } from "@fixture/pinned";

// Return a plain message dict (the MessagesAnnotation reducer coerces it) rather than importing a
// message class, so the fixture's only runtime externals are the ones under test.
function reply(state: typeof MessagesAnnotation.State): {
  messages: Array<{ role: string; content: string }>;
} {
  const last = state.messages.at(-1);
  const text = typeof last?.content === "string" ? last.content : "";
  return { messages: [{ role: "assistant", content: `${banner()}+${marker}: ${text}` }] };
}

export const graph = new StateGraph(MessagesAnnotation)
  .addNode("reply", reply)
  .addEdge("__start__", "reply")
  .addEdge("reply", "__end__")
  .compile();
