import { setTimeout as pause } from "node:timers/promises";

import { catalog, type CommittedUi, type PlanRequest } from "./catalog.js";

export type GenerateText = (
  request: PlanRequest,
  signal?: AbortSignal,
  previousUi?: CommittedUi | null,
) => AsyncIterable<string>;

/** A deterministic SpecStream, including non-idempotent array inserts and an unterminated last line. */
export function demoSpecStream(request: PlanRequest): string {
  const elements = {
    summary: { type: "Text", props: { text: request.prompt }, children: [] },
    tasks: { type: "TaskList", props: { tasks: [] }, children: [] },
    revise: {
      type: "Button",
      props: { label: "Make it more focused" },
      children: [],
      on: {
        press: {
          action: "revisePlan",
          params: { prompt: "Focus on one next step: " + request.prompt },
        },
      },
    },
    feedback: {
      type: "FeedbackForm",
      props: { label: "What would you change?", value: { $bindState: "/feedback" } },
      children: [],
      on: { submit: { action: "revisePlan", params: { prompt: { $state: "/feedback" } } } },
    },
  };
  const patches: unknown[] = [
    { op: "add", path: "/root", value: "plan" },
    {
      op: "add",
      path: "/elements",
      value: { plan: { type: "Card", props: { title: "Your next steps" }, children: [] } },
    },
  ];
  for (const [key, element] of Object.entries(elements)) {
    patches.push({ op: "add", path: "/elements/" + key, value: element });
    patches.push({ op: "add", path: "/elements/plan/children/-", value: key });
  }
  for (const task of [
    "Define a small first milestone",
    "Try it with one person",
    "Review the result and adjust",
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
            "Return only SpecStream JSONL for a complete new plan. Start from an empty specification.",
            "Use Card, Text, TaskList, Button and FeedbackForm. Only bind revisePlan actions. Do not use onSuccess, onError, confirm, watch, navigation or built-in actions. The host provides approval controls.",
          ],
        }),
      },
      {
        role: "user",
        content: previousUi
          ? "Previous plan:\n" +
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
