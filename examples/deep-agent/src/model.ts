// Which model the agents think with.
//
// `DEEP_AGENT_MODEL` takes any `provider:model` string LangChain's `initChatModel` understands — e.g.
// `google-genai:gemini-2.5-flash` with `GOOGLE_API_KEY` set (`@langchain/google-genai` is installed), or
// `anthropic:…` / `openai:…` after adding that provider package. Unset, the agents use the offline
// scripted model, which is what the tests run against.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { ScriptedChatModel, type ScriptedRole } from "./scripted-model.js";

export function selectModel(role: ScriptedRole): BaseChatModel | string {
  const configured = process.env["DEEP_AGENT_MODEL"];
  return configured ? configured : new ScriptedChatModel({ role });
}
