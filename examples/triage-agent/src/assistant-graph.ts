// The chat graph: ask questions about what has been triaged.
//
// The other two graphs in this example are *workloads* — a cron sweep and a per-item pipeline. This
// one exists because the natural next question after "the agent triaged six things" is "so what did
// it decide?", and the natural way to ask that is in words.
//
// It also gives the console's playground something to actually chat with. A `messages` channel is what
// makes the console offer a chat box at all, so a server whose graphs all take structured input has
// no chat surface to demo — see docs/console.md.
//
// Offline like the rest of the example: with no `GOOGLE_API_KEY` it answers from the store directly,
// which for "what did you decide about X" is not a downgrade — the store *is* the answer.

import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { Annotation, END, messagesStateReducer, START, StateGraph } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";

const AssistantState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
});

const DECISIONS_NAMESPACE = ["triage", "decisions"];
const CONVENTIONS_NAMESPACE = ["triage", "conventions"];

interface Decision {
  title?: string;
  category?: string;
  severity?: string;
  author?: string;
  routedBecause?: string;
}

/** The text of the most recent human turn. */
function lastQuestion(messages: readonly BaseMessage[]): string {
  const last = messages.at(-1);
  if (!last) return "";
  return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
}

async function answer(
  state: typeof AssistantState.State,
  config: LangGraphRunnableConfig,
): Promise<Partial<typeof AssistantState.State>> {
  const question = lastQuestion(state.messages);
  const store = config.store;

  if (!store) {
    return { messages: [new AIMessage("I have no store to read decisions from.")] };
  }

  // Semantic when the store is index-backed, a plain listing when it is not. The store answers both.
  const [decisions, conventions] = await Promise.all([
    store.search(DECISIONS_NAMESPACE, { limit: 20, query: question }),
    store.search(CONVENTIONS_NAMESPACE, { limit: 10 }),
  ]);

  const records = decisions.map((entry) => entry.value as Decision);
  const rules = conventions
    .map((entry) => (typeof entry.value["text"] === "string" ? entry.value["text"] : ""))
    .filter((text) => text !== "");

  if (process.env["GOOGLE_API_KEY"]) {
    const model = new ChatGoogleGenerativeAI({
      model: process.env["GOOGLE_MODEL"] ?? "gemini-3.5-flash-lite",
      temperature: 0,
    });
    const reply = await model.invoke([
      {
        role: "user",
        content:
          `You are answering questions about a triage queue. Use only the records below; if they do ` +
          `not answer the question, say so plainly.\n\n` +
          `Decisions:\n${records.map(describe).join("\n") || "(none yet)"}\n\n` +
          `Conventions:\n${rules.map((rule) => `- ${rule}`).join("\n") || "(none)"}\n\n` +
          `Question: ${question}`,
      },
    ]);
    return { messages: [new AIMessage(String(reply.content))] };
  }

  return { messages: [new AIMessage(summarize(question, records, rules))] };
}

function describe(decision: Decision): string {
  return `- [${decision.category ?? "?"}/${decision.severity ?? "?"}] ${decision.title ?? "(untitled)"}${
    decision.author ? ` — reported by ${decision.author}` : ""
  }`;
}

/**
 * The offline answer: report what is in the store rather than pretend to reason about it.
 *
 * Deliberately not a fake-sounding LLM voice. A canned assistant that hedges like a model is worse
 * than one that plainly says "here are the six records I have and the question you asked".
 */
function summarize(question: string, records: Decision[], rules: string[]): string {
  const lines: string[] = [];
  if (records.length === 0) {
    lines.push("Nothing has been triaged yet — run the `sweep` graph and approve an item first.");
  } else {
    const byCategory = new Map<string, number>();
    for (const record of records) {
      const key = record.category ?? "unknown";
      byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
    }
    const breakdown = [...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => `${count} ${category}`)
      .join(", ");
    lines.push(`${records.length} recorded decision(s): ${breakdown}.`);
    lines.push("");
    lines.push(...records.slice(0, 8).map(describe));
  }
  if (rules.length > 0) {
    lines.push("", `Conventions in effect: ${rules.join("; ")}`);
  }
  lines.push(
    "",
    `(Answered from the store — no model was called. Set GOOGLE_API_KEY and I will reason about "${question}" instead.)`,
  );
  return lines.join("\n");
}

export const graph = new StateGraph(AssistantState)
  .addNode("answer", answer)
  .addEdge(START, "answer")
  .addEdge("answer", END)
  .compile();
