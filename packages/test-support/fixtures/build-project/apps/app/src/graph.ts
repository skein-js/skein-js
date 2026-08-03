import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
// A published package nothing else in the image installs. If `skein build` fails to pin it, the
// Dockerfile's graph compatibility probe dies with `ERR_MODULE_NOT_FOUND` — issue #6, reproduced.
import { formatISO } from "date-fns";

import { banner } from "@fixture/lib";

function reply(state: typeof MessagesAnnotation.State): {
  messages: Array<{ role: string; content: string }>;
} {
  const last = state.messages.at(-1);
  const text = typeof last?.content === "string" ? last.content : "";
  // A fixed instant, so the reply is deterministic and the probe needs no clock, network, or key.
  const stamp = formatISO(new Date(0));
  return { messages: [{ role: "assistant", content: `${banner()} @ ${stamp}: ${text}` }] };
}

export const graph = new StateGraph(MessagesAnnotation)
  .addNode("reply", reply)
  .addEdge("__start__", "reply")
  .addEdge("reply", "__end__")
  .compile();
