import { setTimeout as pause } from "node:timers/promises";

import type { UiMessage, SavedUi } from "./trip-contract.js";
import { CATALOG_ID, tripSurfaceIds } from "./trip-contract.js";

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
  const ids = tripSurfaceIds(generationId);
  return [
    {
      version: "1.0",
      createSurface: {
        surfaceId: ids.itinerary,
        catalogId: CATALOG_ID,
        components: [
          { id: "root", component: "Text", text: "Making room for a little adventure…" },
        ],
        dataModel: { summary: prompt },
      },
    },
    {
      version: "1.0",
      updateComponents: {
        surfaceId: ids.itinerary,
        components: [
          {
            id: "root",
            component: "Column",
            children: ["summary", "day1", "day2", "day3", "relax"],
          },
          { id: "summary", component: "Text", text: { "@path": "/summary" } },
          {
            id: "day1",
            component: "Text",
            text: "Day 1 · Arrive slowly. Explore the old town and find a neighborhood café.",
          },
          {
            id: "day2",
            component: "Text",
            text: "Day 2 · Follow your curiosity. Visit a local museum, then leave the afternoon open.",
          },
          {
            id: "day3",
            component: "Text",
            text: "Day 3 · Take the scenic route. Walk in a garden before heading home.",
          },
          {
            id: "relax",
            component: "Button",
            child: "relax_label",
            action: {
              event: {
                name: "reviseTrip",
                context: { prompt: ("Make this trip more relaxed: " + prompt).slice(0, 2000) },
              },
            },
          },
          { id: "relax_label", component: "Text", text: "Make it more relaxed" },
        ],
      },
    },
    {
      version: "1.0",
      updateDataModel: { surfaceId: ids.itinerary, path: "/summary", value: prompt },
    },
    {
      version: "1.0",
      createSurface: {
        surfaceId: ids.preferences,
        catalogId: CATALOG_ID,
        sendDataModel: true,
        components: [
          { id: "root", component: "Column", children: ["feedback", "revise"] },
          {
            id: "feedback",
            component: "TextField",
            label: "What would you change?",
            value: { "@path": "/feedback" },
            placeholder: "Less walking, more food, or an extra day…",
          },
          {
            id: "revise",
            component: "Button",
            child: "revise_label",
            action: {
              event: {
                name: "reviseTrip",
                context: { prompt: { "@path": "/feedback" } },
              },
            },
          },
          { id: "revise_label", component: "Text", text: "Revise trip" },
        ],
        dataModel: { feedback: "" },
      },
    },
    {
      version: "1.0",
      createSurface: {
        surfaceId: ids.tips,
        catalogId: CATALOG_ID,
        components: [
          { id: "root", component: "Column", children: ["tip", "dismiss"] },
          {
            id: "tip",
            component: "Text",
            text: "Keep a little space in your day. The best discoveries rarely need a reservation.",
          },
          {
            id: "dismiss",
            component: "Button",
            child: "dismiss_label",
            action: { event: { name: "dismissTips", context: {} } },
          },
          { id: "dismiss_label", component: "Text", text: "Dismiss travel tips" },
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
          surfaceIds: tripSurfaceIds(request.generationId),
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
