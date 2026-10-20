// The researcher: a Deep Agent that turns a question into research notes.
//
// The briefing assistant also runs it as a *background* job — a "deep dive" — on this same server,
// started, checked, updated and cancelled over the Agent Protocol like any other client would.

import { createDeepAgent } from "deepagents";

import { selectModel } from "./model.js";

export const RESEARCHER_PROMPT =
  "You are a research analyst. Answer the question you are given with concise, well-organized " +
  "notes: why it matters, what has changed, open questions, and a suggested next step.";

export const graph = createDeepAgent({
  model: selectModel("researcher"),
  systemPrompt: RESEARCHER_PROMPT,
});
