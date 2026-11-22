// Turns raw LangGraph SDK messages (as surfaced by `useStream`) into the pieces this UI renders:
// the visible answer text, the model's "thinking", and tool calls/results. Chat models don't return
// a uniform shape — a message's `content` may be a plain string or an array of typed parts, and
// Gemini's reasoning arrives as `thinking` (or `reasoning`) content blocks alongside `text` blocks.

export type Role = "human" | "ai" | "tool" | "other";

interface ContentPartLike {
  type?: string;
  text?: string;
  thinking?: string;
  reasoning?: string;
}

export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface MessageLike {
  id?: string;
  type?: string;
  content?: unknown;
  tool_calls?: ToolCall[];
  name?: string;
  tool_call_id?: string;
}

function parts(content: unknown): ContentPartLike[] {
  if (Array.isArray(content)) {
    return content
      .map((part): ContentPartLike | null => {
        if (typeof part === "string") return { type: "text", text: part };
        // Guard against null/primitive entries so answerText/thinkingText never deref a non-object.
        return part != null && typeof part === "object" ? (part as ContentPartLike) : null;
      })
      .filter((part): part is ContentPartLike => part !== null);
  }

  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

/** The visible answer text of a message — its `text` parts, joined. Thinking is deliberately excluded. */
export function answerText(content: unknown): string {
  return parts(content)
    .filter((part) => part.type === undefined || part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/** The model's reasoning, if any — Gemini emits `thinking` blocks; other providers use `reasoning`. */
export function thinkingText(content: unknown): string {
  return parts(content)
    .filter((part) => part.type === "thinking" || part.type === "reasoning")
    .map((part) => part.thinking ?? part.reasoning ?? "")
    .join("");
}

/** Tool calls requested on an AI message (already normalized by the SDK), if any. */
export function toolCalls(message: MessageLike): ToolCall[] {
  return Array.isArray(message.tool_calls) ? message.tool_calls : [];
}

/** A human-friendly label for a tool by name. */
export function toolLabel(name: string): string {
  if (name === "web_search") return "Web search";
  if (name === "save_memory") return "Saved a memory";
  if (name === "recall_memory") return "Recalled memory";
  if (name === "get_weather") return "Weather";
  if (name === "search_flights") return "Flight search";
  if (name === "book_flight") return "Book flight";
  return name;
}

export function roleOf(message: MessageLike): Role {
  if (message.type === "human") return "human";
  if (message.type === "tool") return "tool";

  if (message.type === "ai" || message.type === "assistant" || message.type === undefined) {
    return "ai";
  }

  // system / remove / function — not part of the visible transcript.
  return "other";
}

/**
 * Pair each AI turn's tool calls with the result of the following `tool` messages, keyed by
 * `"<messageIndex>-<callIndex>"`. Matches by `tool_call_id` when the call has an id, and falls back
 * to positional pairing within the turn (the SDK types a tool call's id as optional). Lets a
 * ToolCallCard show its result even when the call carries no id.
 */
export function toolResultsByCall(messages: MessageLike[]): Map<string, string> {
  const results = new Map<string, string>();
  messages.forEach((message, messageIndex) => {
    if (roleOf(message) !== "ai") return;
    const calls = toolCalls(message);
    if (calls.length === 0) return;
    const followingToolMessages: MessageLike[] = [];

    for (let j = messageIndex + 1; j < messages.length && roleOf(messages[j]!) === "tool"; j++) {
      followingToolMessages.push(messages[j]!);
    }

    calls.forEach((call, callIndex) => {
      const byId = call.id
        ? followingToolMessages.find((tool) => tool.tool_call_id === call.id)
        : undefined;

      const match = byId ?? followingToolMessages[callIndex];
      if (match) results.set(`${messageIndex}-${callIndex}`, answerText(match.content));
    });
  });
  return results;
}
