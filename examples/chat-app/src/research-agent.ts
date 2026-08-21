// A real-world research + trip-planning assistant graph: a Gemini ReAct agent that (1) thinks out
// loud (Gemini "thinking" streamed as reasoning content blocks), (2) searches the web, (3) remembers
// facts about the user across threads via skein's long-term store (`getStore()`, injected by the run
// engine — see docs/storage.md), and (4) plans trips with tools that return structured JSON the UI
// renders as cards — including `book_flight`, which pauses for human-in-the-loop approval via
// LangGraph's `interrupt()`. It's a plain LangGraph.js graph; skein serves it unchanged.
//
// The tools and their pure helpers live in `research-tools.ts` and `trip-tools.ts` so tests can
// exercise them without a model. This module only assembles the model + agent.

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { createAgent, dynamicSystemPromptMiddleware } from "langchain";

import { buildSystemPromptWithMemories, saveMemoryTool, webSearchTool } from "./research-tools.js";
import { bookFlightTool, getWeatherTool, searchFlightsTool } from "./trip-tools.js";

/**
 * The model. Gemini "thinking" is enabled so the agent streams its reasoning as `thinking` content
 * blocks — the frontend renders these in a collapsible panel. Model overridable via `GOOGLE_MODEL`.
 */
const model = new ChatGoogleGenerativeAI({
  model: process.env["GOOGLE_MODEL"] ?? "gemini-2.5-flash",
  temperature: 0,
  thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 },
});

export const graph = createAgent({
  model,
  // Research tools (web search + long-term memory) plus the trip-planner tools that return structured
  // JSON the UI renders as cards — and `book_flight`, which pauses for human-in-the-loop approval.
  tools: [webSearchTool, saveMemoryTool, getWeatherTool, searchFlightsTool, bookFlightTool],
  // Recall is an application choice (see buildSystemPromptWithMemories): this example auto-injects
  // relevant memories into the system prompt before each model call, so recall doesn't depend on the
  // model invoking a tool. skein itself stays unopinionated — it only makes getStore() available.
  middleware: [dynamicSystemPromptMiddleware(buildSystemPromptWithMemories)],
});
