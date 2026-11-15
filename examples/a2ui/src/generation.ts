import { setTimeout as pause } from "node:timers/promises";

import type { UiMessage, SavedUi } from "./ui-contract.js";
import { CATALOG_ID, uiSurfaceIds } from "./ui-contract.js";

export interface GenerationRequest {
  prompt: string;
  generationId: string;
  systemPrompt: string;
  previousUi: SavedUi | null;
}
export type GenerateText = (
  request: GenerationRequest,
  signal?: AbortSignal,
) => AsyncIterable<string>;

export function demoMessages(prompt: string, generationId: string): UiMessage[] {
  const ids = uiSurfaceIds(generationId);
  const form = /form|registration|sign.?up|contact/i.test(prompt);
  const cards = /product|pricing|compar/i.test(prompt);
  const title = form
    ? "UI feedback form"
    : cards
      ? "Choose your workspace"
      : "Website traffic dashboard";
  const labels = form
    ? [
        "Describe a change",
        "Submit it through the feedback field below",
        "Review the updated interface",
      ]
    : cards
      ? ["Starter · $12 / month", "Studio · $29 / month", "Team · $79 / month"]
      : ["Total sessions · 284,520", "Conversion rate · 3.42%", "Average visit · 2m 48s"];
  const content = labels.flatMap((label, index) => [
    { id: "item_" + index, component: "Card", child: "item_text_" + index },
    { id: "item_text_" + index, component: "Text", text: label },
  ]);
  return [
    {
      version: "1.0",
      createSurface: {
        surfaceId: ids.canvas,
        catalogId: CATALOG_ID,
        components: [{ id: "root", component: "Text", text: "Sketching your interface…" }],
        dataModel: { summary: prompt },
      },
    },
    {
      version: "1.0",
      updateComponents: {
        surfaceId: ids.canvas,
        components: [
          {
            id: "root",
            component: "Column",
            children: ["heading", "summary", "content", "refine"],
          },
          { id: "heading", component: "Text", text: title },
          { id: "summary", component: "Text", text: { "@path": "/summary" } },
          { id: "content", component: "Row", children: labels.map((_, index) => "item_" + index) },
          ...content,
          {
            id: "refine",
            component: "Button",
            child: "refine_label",
            action: {
              event: {
                name: "reviseUi",
                context: { prompt: ("Make this UI simpler: " + prompt).slice(0, 2000) },
              },
            },
          },
          { id: "refine_label", component: "Text", text: "Make it simpler" },
        ],
      },
    },
    { version: "1.0", updateDataModel: { surfaceId: ids.canvas, path: "/summary", value: prompt } },
    {
      version: "1.0",
      createSurface: {
        surfaceId: ids.controls,
        catalogId: CATALOG_ID,
        sendDataModel: true,
        components: [
          { id: "root", component: "Column", children: ["feedback", "revise"] },
          {
            id: "feedback",
            component: "TextField",
            label: "What would you change?",
            value: { "@path": "/feedback" },
            placeholder: "Describe a change to the interface",
          },
          {
            id: "revise",
            component: "Button",
            child: "revise_label",
            action: { event: { name: "reviseUi", context: { prompt: { "@path": "/feedback" } } } },
          },
          { id: "revise_label", component: "Text", text: "Update UI" },
        ],
        dataModel: { feedback: "" },
      },
    },
    {
      version: "1.0",
      createSurface: {
        surfaceId: ids.notes,
        catalogId: CATALOG_ID,
        components: [
          { id: "root", component: "Column", children: ["note", "dismiss"] },
          {
            id: "note",
            component: "Text",
            text: "Illustrative sample data. Approval records a decision; it does not publish or submit anything.",
          },
          {
            id: "dismiss",
            component: "Button",
            child: "dismiss_label",
            action: { event: { name: "dismissNotes", context: {} } },
          },
          { id: "dismiss_label", component: "Text", text: "Dismiss notes" },
        ],
        dataModel: {},
      },
    },
  ];
}

export function demoResponse(prompt: string, generationId: string): string {
  return "<a2ui-json>" + JSON.stringify(demoMessages(prompt, generationId)) + "</a2ui-json>";
}

export const generateDemoText: GenerateText = async function* (request, signal) {
  const text = demoResponse(request.prompt, request.generationId);
  for (let offset = 0; offset < text.length; offset += 160) {
    await pause(45, undefined, { signal });
    yield text.slice(offset, offset + 160);
  }
};

export const generateModelText: GenerateText = async function* (request, signal) {
  const configuredModel = process.env["A2UI_MODEL"];
  if (!configuredModel) throw new Error("Set A2UI_MODEL to a LangChain provider:model string");
  const { initChatModel } = await import("langchain/chat_models/universal");
  const model = await initChatModel(configuredModel);
  const chunks = await model.stream(
    [
      { role: "system", content: request.systemPrompt },
      {
        role: "user",
        content: JSON.stringify({
          prompt: request.prompt,
          surfaceIds: uiSurfaceIds(request.generationId),
          previousUi: request.previousUi,
        }),
      },
    ],
    { signal },
  );
  for await (const chunk of chunks) {
    if (typeof chunk.content === "string") yield chunk.content;
    else
      for (const block of chunk.content)
        if (block.type === "text" && typeof block.text === "string") yield block.text;
  }
};
