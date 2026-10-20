// A chat model that needs no API key: it reads the conversation and decides the next step by rule.
//
// This is not a stub to apologise for. It is what makes the example runnable by someone who cloned the
// repo two minutes ago, and it is *deterministic*, which is what lets the end-to-end test assert on
// planning, files, delegation, approval and async tasks without a model in the loop. Every Deep Agents
// feature it exercises is the real one — only the decisions are scripted.
//
// The supervisor reacts to a directive at the start of the user's message:
//
//   plan: a; b            -> write_todos               research: topic   -> task (sync subagent)
//   note: text            -> write_file /notes.md      background: topic -> start_async_task
//   read-note             -> read_file  /notes.md      check: <id>       -> check_async_task
//   remember: text        -> write_file /memories/…    update: <id> | m  -> update_async_task
//   recall                -> read_file  /memories/…    cancel: <id>      -> cancel_async_task
//   send: to | body       -> send_report (needs a human's approval)
//
// After a tool result it answers `Done. <result>`; a message with no directive (which is what a
// subagent receives) gets a short canned answer.

import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

/** The durable memory file — under `/memories/`, so it routes to the store-backed backend. */
export const MEMORY_FILE = "/memories/facts.md";
/** The per-thread scratch file — anywhere else, so it lives in thread state. */
export const NOTES_FILE = "/notes.md";

type ToolCall = { name: string; args: Record<string, unknown> };

const textOf = (message: BaseMessage): string =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);

/** Split `head | tail` on the first `|`, trimming both sides. */
function splitPair(text: string): [string, string] {
  const at = text.indexOf("|");
  return at === -1 ? [text.trim(), ""] : [text.slice(0, at).trim(), text.slice(at + 1).trim()];
}

/** The tool call a directive asks for, or `undefined` for plain text. */
function toolCallFor(request: string): ToolCall | undefined {
  const match = /^([a-z-]+)(?::\s*([\s\S]*))?$/.exec(request.trim());
  if (!match) return undefined;
  const [, directive, rest = ""] = match;
  switch (directive) {
    case "plan":
      return {
        name: "write_todos",
        args: {
          todos: rest
            .split(";")
            .map((item) => item.trim())
            .filter(Boolean)
            .map((content) => ({ content, status: "pending" })),
        },
      };
    case "note":
      return { name: "write_file", args: { file_path: NOTES_FILE, content: rest } };
    case "read-note":
      return { name: "read_file", args: { file_path: NOTES_FILE } };
    case "remember":
      return { name: "write_file", args: { file_path: MEMORY_FILE, content: rest } };
    case "recall":
      return { name: "read_file", args: { file_path: MEMORY_FILE } };
    case "research":
      return { name: "task", args: { description: rest, subagent_type: "researcher" } };
    case "background":
      return {
        name: "start_async_task",
        args: { description: rest, agentName: "background-researcher" },
      };
    case "check":
      return { name: "check_async_task", args: { taskId: rest.trim() } };
    case "update": {
      const [taskId, message] = splitPair(rest);
      return { name: "update_async_task", args: { taskId, message } };
    }
    case "cancel":
      return { name: "cancel_async_task", args: { taskId: rest.trim() } };
    case "send": {
      const [to, body] = splitPair(rest);
      return { name: "send_report", args: { to, body } };
    }
    default:
      return undefined;
  }
}

/** The next message the model would send, given the conversation so far. */
export function planNextMessage(messages: BaseMessage[]): AIMessage {
  const last = messages.at(-1);
  if (last?.getType() === "tool") return new AIMessage({ content: `Done. ${textOf(last)}` });

  const request = [...messages].reverse().find((message) => message.getType() === "human");
  const text = request ? textOf(request) : "";
  const call = toolCallFor(text);
  if (!call) return new AIMessage({ content: `Findings on "${text.trim()}": all clear.` });
  return new AIMessage({
    content: "",
    tool_calls: [{ id: `call_${crypto.randomUUID()}`, type: "tool_call", ...call }],
  });
}

/** A `BaseChatModel` over {@link planNextMessage}. Stateless, so one instance serves every run. */
export class ScriptedChatModel extends BaseChatModel {
  _llmType(): string {
    return "scripted";
  }

  // The tools are already named in the script; binding them changes nothing.
  override bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const message = planNextMessage(messages);
    return { generations: [{ message, text: textOf(message) }] };
  }
}
