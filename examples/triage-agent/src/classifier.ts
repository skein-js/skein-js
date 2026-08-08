// Who decides what an issue is.
//
// Two implementations behind one interface, chosen by whether a model key is present:
//
//   • Gemini, when `GOOGLE_API_KEY` is set — the real thing.
//   • A deterministic rule-based classifier otherwise.
//
// The offline one is not a stub to be embarrassed about; it is what makes this example runnable by
// someone who cloned the repo two minutes ago with no accounts and no network. An example whose first
// step is "go get an API key" is an example most people never see run. It is also *deterministic*,
// which is what lets the triage decisions be unit-tested at all.

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

import { parseVerdict, type TriageItem, type Verdict } from "./triage-sources.js";

export interface ClassifierContext {
  /** Conventions the agent has learned about this project. */
  conventions: readonly string[];
  /** Titles of items already triaged that look related. */
  related: readonly string[];
}

export interface Classifier {
  /** How the verdict was reached, surfaced in the UI so nobody mistakes rules for a model. */
  readonly kind: "model" | "rules";
  readonly label: string;
  classify(item: TriageItem, context: ClassifierContext): Promise<Verdict>;
}

export function createClassifier(): Classifier {
  return process.env["GOOGLE_API_KEY"] ? geminiClassifier() : rulesClassifier();
}

/**
 * Overridable, like every other example in this repo — triage is a cheap, high-volume, structured-output
 * task, so the smallest current Flash model is the right default and the knob is there for when it isn't.
 */
const MODEL = process.env["GOOGLE_MODEL"] ?? "gemini-3.5-flash-lite";

function geminiClassifier(): Classifier {
  return {
    kind: "model",
    label: MODEL,
    async classify(item, context) {
      const model = new ChatGoogleGenerativeAI({ model: MODEL, temperature: 0 });
      const response = await model.invoke([{ role: "user", content: prompt(item, context) }]);
      const raw =
        typeof response.content === "string" ? response.content : JSON.stringify(response.content);
      return parseVerdict(raw);
    },
  };
}

function prompt(item: TriageItem, context: ClassifierContext): string {
  const conventions =
    context.conventions.length > 0
      ? `\n\nConventions this project already follows:\n${context.conventions.map((line) => `- ${line}`).join("\n")}`
      : "";
  const related =
    context.related.length > 0
      ? `\n\nAlready triaged and possibly related:\n${context.related.map((line) => `- ${line}`).join("\n")}`
      : "";
  return (
    `Triage this issue. Answer with JSON only: ` +
    `{"category":"bug|feature|question|docs|spam","severity":"low|medium|high",` +
    `"reply":"a short reply to post","reasoning":"one sentence"}.` +
    conventions +
    related +
    `\n\nTitle: ${item.title}\nAuthor: ${item.author}\n` +
    `Labels: ${item.labels.join(", ") || "none"}\n\n${item.body}`
  );
}

/** Signals, ordered most-specific-first. The first category to match wins. */
const CATEGORY_RULES: { category: Verdict["category"]; test: RegExp }[] = [
  { category: "spam", test: /\b(buy|cheap|followers|click here|best price|crypto|casino)\b/i },
  { category: "docs", test: /\b(docs?|documentation|readme|typo|guide|example)\b/i },
  {
    category: "question",
    test: /\b(how do i|how can i|is it possible|question|sorry if)\b|\?\s*$/i,
  },
  {
    category: "bug",
    test: /\b(crash|error|exception|stack|traceback|500|fails?|broken|regression)\b/i,
  },
  {
    category: "feature",
    test: /\b(add support|feature request|would be great|it would be nice|enhancement|please add)\b/i,
  },
];

/** Severity signals. Anything unmatched is `low`; a production-down report is not. */
const HIGH_SEVERITY = /\b(production is down|data loss|security|cve|crash|exits immediately)\b/i;
const MEDIUM_SEVERITY = /\b(intermittent|under load|regression|500|fails)\b/i;

function rulesClassifier(): Classifier {
  return {
    kind: "rules",
    label: "offline rules",
    classify(item, context) {
      const haystack = `${item.title}\n${item.body}\n${item.labels.join(" ")}`;
      const category =
        CATEGORY_RULES.find((rule) => rule.test.test(haystack))?.category ?? "question";
      const severity =
        category === "spam"
          ? "low"
          : HIGH_SEVERITY.test(haystack)
            ? "high"
            : MEDIUM_SEVERITY.test(haystack)
              ? "medium"
              : "low";
      return Promise.resolve({
        category,
        severity,
        reply: replyFor(category, item),
        reasoning:
          `Matched the ${category} rule at ${severity} severity` +
          (context.conventions.length > 0
            ? `, with ${context.conventions.length} learned convention(s) in scope`
            : "") +
          `. No model was called — set GOOGLE_API_KEY to use ${MODEL} instead.`,
      });
    },
  };
}

function replyFor(category: Verdict["category"], item: TriageItem): string {
  switch (category) {
    case "bug":
      return `Thanks for the report, @${item.author} — reproducing this now. If you can add your version and a minimal repro it will speed things up a lot.`;
    case "feature":
      return `Thanks @${item.author} — noting this as a feature request. What does the workaround look like for you today?`;
    case "question":
      return `Good question, @${item.author}. Answering below, and if the docs did not cover it that is a docs bug on our side.`;
    case "docs":
      return `Thanks @${item.author} — that is a documentation gap, and a fair one. Opening a docs fix.`;
    case "spam":
      return "";
  }
}
