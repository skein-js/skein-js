// The offline stand-in for a real model, so the example runs — and its tests pass — with no API key.
//
// It plays two roles, the same two a real model would:
//
// - **assistant** — the briefing assistant itself. It recognizes a handful of plain-English requests
//   and works through them the way a capable model would: check what it knows about you, plan, delegate
//   the research, write the draft, and wait for your sign-off before emailing anything.
// - **researcher** — the research subagent, which answers with structured notes on whatever it is asked.
//
// Every Deep Agents feature it drives is the real one; only the decisions are scripted. Set
// `DEEP_AGENT_MODEL` (see `model.ts`) and the same graphs run against a real model instead.
//
// What the assistant understands:
//
//   "Brief me on <topic>"                          → plans, researches, drafts /briefings/<topic>.md
//   "Email the briefing to sam@example.com"        → asks you to approve, edit or reject the email
//   "Remember that I prefer bullet points"         → saves to /memories/preferences.md (all your chats)
//   "What do you remember about me?"               → reads your saved preferences back
//   "Start a deep dive on <topic>"                 → launches a background research task
//   "How is the deep dive going?"                  → checks on it
//   "Tell the deep dive to <instruction>"          → sends it a follow-up
//   "Cancel the deep dive"                         → stops it
//
// A deep-dive request may name a task id explicitly; otherwise the most recent one in the chat is used.

import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage, type ToolMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

/** Your briefing preferences — under `/memories/`, so they live in the store and follow you. */
export const PREFERENCES_FILE = "/memories/preferences.md";
/** Where a briefing is drafted — thread state, so it belongs to the conversation that wrote it. */
export const briefingFileFor = (topic: string): string => `/briefings/${slugOf(topic)}.md`;

export type ScriptedRole = "assistant" | "researcher";

type ToolCall = { name: string; args: Record<string, unknown> };

const TASK_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function slugOf(topic: string): string {
  return (
    topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "briefing"
  );
}

const textOf = (message: BaseMessage): string =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);

const trimTopic = (topic: string): string => topic.trim().replace(/[.?!]+$/, "");

/** A tool result, named by the call it answers — some tools build their `ToolMessage` without one. */
type ToolResult = { name: string; content: string };

/** The latest request and everything the agent has done about it since. */
function currentTurn(messages: BaseMessage[]): { request: string; results: ToolResult[] } {
  const at = messages.findLastIndex((message) => message.getType() === "human");
  const turn = messages.slice(at + 1);
  const callNames = new Map(
    turn.flatMap((message) => ((message as AIMessage).tool_calls ?? []).map((c) => [c.id, c.name])),
  );
  const results = (turn.filter((message) => message.getType() === "tool") as ToolMessage[]).map(
    (result) => ({
      name: result.name ?? callNames.get(result.tool_call_id) ?? "",
      content: textOf(result),
    }),
  );
  return { request: at === -1 ? "" : textOf(messages[at]!).trim(), results };
}

/** The most recent briefing drafted in this chat — the `write_file` call that saved it. */
function latestBriefing(messages: BaseMessage[]): { path: string; content: string } | undefined {
  for (const message of [...messages].reverse()) {
    const calls = (message as AIMessage).tool_calls ?? [];
    const draft = calls.find(
      (call) =>
        call.name === "write_file" && String(call.args["file_path"]).startsWith("/briefings/"),
    );
    if (draft)
      return { path: String(draft.args["file_path"]), content: String(draft.args["content"]) };
  }
  return undefined;
}

/** The deep dive a request is about: an id it names, else the latest one started in this chat. */
function deepDiveId(request: string, messages: BaseMessage[]): string | undefined {
  const named = TASK_ID.exec(request)?.[0];
  if (named) return named;
  for (const message of [...messages].reverse()) {
    if (message.getType() !== "tool") continue;
    const launched = /taskId: ([\w-]+)/.exec(textOf(message));
    if (launched) return launched[1];
  }
  return undefined;
}

const call = (name: string, args: Record<string, unknown>): AIMessage =>
  new AIMessage({
    content: "",
    tool_calls: [{ id: `call_${crypto.randomUUID()}`, type: "tool_call", name, args }],
  });

const say = (content: string): AIMessage => new AIMessage({ content });

/** Format the researcher's notes the way the reader asked for, or as a short summary by default. */
function draftBriefing(topic: string, notes: string, preferences: string): string {
  const points = notes
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter((line) => line && !line.endsWith(":"));
  const concise = /\b(short|concise|brief)\b/i.test(preferences);
  const kept = concise ? points.slice(0, 2) : points;
  const body = /\bbullet/i.test(preferences)
    ? kept.map((point) => `- ${point}`).join("\n")
    : kept.join(" ");
  return `# Briefing: ${topic}\n\n${body}\n`;
}

/** Steps through a briefing: preferences → plan → research → draft → hand back. */
function nextBriefingStep(topic: string, results: ToolResult[]): AIMessage {
  const last = results.at(-1);
  if (!last) return call("read_file", { file_path: PREFERENCES_FILE });
  switch (last.name) {
    case "read_file":
      return call("write_todos", {
        todos: [
          { content: "Check your briefing preferences", status: "completed" },
          { content: `Research ${topic}`, status: "in_progress" },
          { content: "Draft the briefing", status: "pending" },
          { content: "Save it for your review", status: "pending" },
        ],
      });
    case "write_todos":
      return call("task", {
        subagent_type: "researcher",
        description: `Research ${topic} for a one-page briefing.`,
      });
    case "task": {
      const preferencesResult = results.find((result) => result.name === "read_file");
      const preferences =
        preferencesResult && !/not found/i.test(preferencesResult.content)
          ? preferencesResult.content
          : "";
      return call("write_file", {
        file_path: briefingFileFor(topic),
        content: draftBriefing(topic, last.content, preferences),
      });
    }
    default:
      return say(
        `Your briefing on ${topic} is ready in ${briefingFileFor(topic)}. ` +
          `Say "email the briefing to …" when you want to send it.`,
      );
  }
}

/** What the assistant says once a single-tool request has its result. */
function reportResult(result: ToolResult, request: string): AIMessage {
  const { content } = result;
  switch (result.name) {
    case "write_file":
      return say("Got it — I'll keep that in mind for every future briefing.");
    case "read_file":
      return say(
        /not found/i.test(content)
          ? "I don't have any saved preferences for you yet."
          : `Here's what I remember about your preferences:\n${content}`,
      );
    case "send_briefing":
      return say(
        content.startsWith("Emailed") ? content : `I didn't send the briefing. ${content}`,
      );
    case "start_async_task": {
      const id = /taskId: ([\w-]+)/.exec(content)?.[1];
      const topic = /deep dive (?:on|into)\s+(.+)/i.exec(request)?.[1];
      return id
        ? say(
            `I've started a deep dive on ${trimTopic(topic ?? "that")} in the background ` +
              `(taskId: ${id}). Ask me how it's going any time.`,
          )
        : say(content);
    }
    default:
      return say(content);
  }
}

/** The assistant's next message, given the conversation so far. */
export function nextAssistantMessage(messages: BaseMessage[]): AIMessage {
  const { request, results } = currentTurn(messages);

  const briefing = /\bbrief(?:ing)?\s+(?:me\s+)?(?:on|about)\s+(.+)/i.exec(request);
  if (briefing && !/\bemail\b|\bsend\b/i.test(request)) {
    return nextBriefingStep(trimTopic(briefing[1]!), results);
  }

  const done = results.at(-1);
  if (done) return reportResult(done, request);

  const email = /\b(?:email|send)\b.*\bbriefing\b.*\bto\s+(\S+@\S+?)[.?!]*$/i.exec(request);
  if (email) {
    const draft = latestBriefing(messages);
    if (!draft) return say("There's no briefing in this conversation yet — ask me for one first.");
    const subject = draft.content.split("\n")[0]!.replace(/^#\s*/, "");
    return call("send_briefing", { to: email[1], subject, body: draft.content });
  }

  const remember = /^(?:please\s+)?(?:remember|note)\s+(?:that\s+)?(.+)/i.exec(request);
  if (remember) return call("write_file", { file_path: PREFERENCES_FILE, content: remember[1] });

  if (/\bwhat do you (?:know|remember)\b|\bmy preferences\b/i.test(request)) {
    return call("read_file", { file_path: PREFERENCES_FILE });
  }

  const startDeepDive = /\b(?:start|run|kick off)\b.*\bdeep dive (?:on|into)\s+(.+)/i.exec(request);
  if (startDeepDive) {
    return call("start_async_task", {
      agentName: "deep-researcher",
      description: trimTopic(startDeepDive[1]!),
    });
  }

  if (/\bdeep dive\b/i.test(request)) {
    const taskId = deepDiveId(request, messages);
    if (!taskId) return say("There's no deep dive running in this conversation.");
    const followUp = /\btell the deep dive(?:\s+[\w-]+)?\s+to\s+(.+)/i.exec(request);
    if (followUp) return call("update_async_task", { taskId, message: followUp[1] });
    if (/\b(?:cancel|stop)\b/i.test(request)) return call("cancel_async_task", { taskId });
    return call("check_async_task", { taskId });
  }

  return say(
    'I prepare research briefings. Try "brief me on <topic>", "remember that I prefer bullet ' +
      'points", or "start a deep dive on <topic>".',
  );
}

/** The researcher's notes on whatever it was last asked — labelled as offline sample material. */
export function nextResearcherMessage(messages: BaseMessage[]): AIMessage {
  const { request } = currentTurn(messages);
  const subject = trimTopic(request)
    .replace(/^research\s+/i, "")
    .replace(/\s+for a one-page briefing$/i, "");
  return say(
    `Research notes on ${subject} (offline sample):\n` +
      `- Why it matters now: interest in ${subject} is rising among teams planning their next quarter.\n` +
      `- What has changed: recent work has made ${subject} cheaper and easier to adopt.\n` +
      `- Open questions: costs at scale and how ${subject} fits existing workflows.\n` +
      `- Suggested next step: a small pilot with a clear success measure.`,
  );
}

/** A `BaseChatModel` that plays one {@link ScriptedRole}. Stateless, so one instance serves every run. */
export class ScriptedChatModel extends BaseChatModel {
  readonly role: ScriptedRole;

  constructor(fields: BaseChatModelParams & { role?: ScriptedRole } = {}) {
    super(fields);
    this.role = fields.role ?? "assistant";
  }

  _llmType(): string {
    return "scripted";
  }

  // The tools are already named in the script; binding them changes nothing.
  override bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const message =
      this.role === "researcher" ? nextResearcherMessage(messages) : nextAssistantMessage(messages);
    return { generations: [{ message, text: textOf(message) }] };
  }
}
