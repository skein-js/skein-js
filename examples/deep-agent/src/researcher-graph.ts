// The research agent the supervisor runs *asynchronously*: a separate graph on the same server,
// started, checked, updated and cancelled over the Agent Protocol like any other client would.

import { createDeepAgent } from "deepagents";

import { selectModel } from "./model.js";

export const graph = createDeepAgent({
  model: selectModel(),
  systemPrompt: "You are a research assistant. Answer the question you are given concisely.",
});
