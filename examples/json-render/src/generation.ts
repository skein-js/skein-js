import { setTimeout as pause } from "node:timers/promises";

import { catalog, type CommittedUi, type UiRequest } from "./catalog.js";

export type GenerateText = (
  request: UiRequest,
  signal?: AbortSignal,
  previousUi?: CommittedUi | null,
) => AsyncIterable<string>;

/** A deterministic SpecStream, including non-idempotent array inserts and an unterminated last line. */
export function demoSpecStream(request: UiRequest): string {
  const form = /form|registration|sign.?up|contact/i.test(request.prompt);
  const cards = /product|pricing|compar/i.test(request.prompt);
  const title = form
    ? "UI feedback form"
    : cards
      ? "Choose your workspace"
      : "Website traffic dashboard";
  const dashboard = {
    metrics: {
      type: "Grid",
      props: { columns: 3 },
      children: ["metric_a", "metric_b", "metric_c"],
    },
    metric_a: {
      type: "Metric",
      props: {
        label: cards ? "Starter" : "Total sessions",
        value: cards ? "$12" : "284,520",
        detail: "Illustrative sample",
      },
      children: [],
    },
    metric_b: {
      type: "Metric",
      props: {
        label: cards ? "Studio" : "Conversion rate",
        value: cards ? "$29" : "3.42%",
        detail: "Illustrative sample",
      },
      children: [],
    },
    metric_c: {
      type: "Metric",
      props: {
        label: cards ? "Team" : "Average visit",
        value: cards ? "$79" : "2m 48s",
        detail: "Illustrative sample",
      },
      children: [],
    },
    table: {
      type: "Table",
      props: {
        caption: cards ? "Plan comparison" : "Traffic by channel",
        columns: ["Item", "Value", "Status"],
        rows: cards
          ? [
              ["Starter", "1 workspace", "Available"],
              ["Studio", "5 workspaces", "Available"],
              ["Team", "Unlimited", "Available"],
            ]
          : [
              ["Organic search", "118,400", "+12.4%"],
              ["Direct", "64,200", "+8.2%"],
              ["Paid search", "42,100", "+4.5%"],
            ],
      },
      children: [],
    },
  };
  const elements = {
    summary: { type: "Text", props: { text: request.prompt }, children: [] },
    ...(form ? {} : dashboard),
    tasks: { type: "TaskList", props: { tasks: [] }, children: [] },
    revise: {
      type: "Button",
      props: { label: "Make it simpler" },
      children: [],
      on: {
        press: {
          action: "reviseUi",
          params: { prompt: ("Make this UI simpler: " + request.prompt).slice(0, 2000) },
        },
      },
    },
    feedback: {
      type: "FeedbackForm",
      props: { label: "What would you change?", value: { $bindState: "/feedback" } },
      children: [],
      on: { submit: { action: "reviseUi", params: { prompt: { $state: "/feedback" } } } },
    },
  };
  const patches: unknown[] = [
    { op: "add", path: "/root", value: "plan" },
    {
      op: "add",
      path: "/elements",
      value: { plan: { type: "Card", props: { title }, children: [] } },
    },
  ];
  for (const [key, element] of Object.entries(elements)) {
    patches.push({ op: "add", path: "/elements/" + key, value: element });
    if (!key.startsWith("metric_"))
      patches.push({ op: "add", path: "/elements/plan/children/-", value: key });
  }
  for (const task of [
    "Explore the generated components",
    "Ask for a change in the chat or form",
    "Review the next version",
  ]) {
    patches.push({ op: "add", path: "/elements/tasks/props/tasks/-", value: task });
  }
  return patches.map((patch) => JSON.stringify(patch)).join("\n");
}

export const generateDemoText: GenerateText = async function* (request, signal) {
  const text = demoSpecStream(request);
  // Split inside JSON lines rather than treating a transport chunk as a patch boundary.
  for (let offset = 0; offset < text.length; offset += 180) {
    await pause(70, undefined, { signal });
    yield text.slice(offset, offset + 180);
  }
};

export const generateModelText: GenerateText = async function* (request, signal, previousUi) {
  const configuredModel = process.env["JSON_RENDER_MODEL"];
  if (!configuredModel)
    throw new Error("Set JSON_RENDER_MODEL to a LangChain provider:model string");
  const { initChatModel } = await import("langchain/chat_models/universal");
  const model = await initChatModel(configuredModel);
  const chunks = await model.stream(
    [
      {
        role: "system",
        content: catalog.prompt({
          customRules: [
            "Return only SpecStream JSONL for a complete new interface. Start from an empty specification.",
            "Use Card, Grid, Metric, Table, Text, TaskList, Button and FeedbackForm. Only bind reviseUi actions. Do not use onSuccess, onError, confirm, watch, navigation or built-in actions. The host provides approval controls.",
          ],
        }),
      },
      {
        role: "user",
        content: previousUi
          ? "Previous UI:\n" +
            JSON.stringify(previousUi.spec) +
            "\nRequested revision:\n" +
            request.prompt
          : request.prompt,
      },
    ],
    { signal },
  );
  for await (const chunk of chunks) {
    // Reasoning/tool blocks are not SpecStream text.
    if (typeof chunk.content === "string") yield chunk.content;
    else
      for (const block of chunk.content) {
        if (block.type === "text" && typeof block.text === "string") yield block.text;
      }
  }
};
