import { setTimeout as pause } from "node:timers/promises";

import { basicCatalog, MessageProcessor } from "@a2ui/web_core/v1_0";

import type { GenerateText } from "./generation.js";
import { uiSurfaceIds, type RendererMetadata, type UiMessage } from "./ui-contract.js";

export function rendererMetadata(): RendererMetadata {
  const processor = new MessageProcessor([basicCatalog]);

  try {
    return {
      a2uiRendererCapabilities: processor.getRendererCapabilities({
        versions: ["1.0"],
        includeInlineCatalogs: false,
      }),
    } as RendererMetadata;
  } finally {
    processor.dispose();
  }
}

export function fixtureMessages(prompt: string, generationId: string): UiMessage[] {
  const ids = uiSurfaceIds(generationId);
  const profile = /profile|octocat/i.test(prompt);
  const recent = /recently pushed|torvalds/i.test(prompt);

  const title = profile
    ? "GitHub profile"
    : recent
      ? "Recently pushed repositories"
      : "skein-js/skein-js";

  const labels = profile
    ? [
        "Describe a change",
        "Submit it through the feedback field below",
        "Review the updated interface",
      ]
    : recent
      ? ["linux · C", "uemacs · C", "pesconvert · C"]
      : ["Stars · 124", "Forks · 8", "Default branch · main"];

  const content = labels.flatMap((label, index) => [
    { id: "item_" + index, component: "Card", child: "item_text_" + index },
    { id: "item_text_" + index, component: "Text", text: label },
  ]);
  return [
    {
      version: "1.0",
      createSurface: {
        surfaceId: ids.canvas,
        catalogId: basicCatalog.id,
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
        catalogId: basicCatalog.id,
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
        catalogId: basicCatalog.id,
        components: [
          { id: "root", component: "Column", children: ["note", "dismiss"] },
          {
            id: "note",
            component: "Text",
            text: "Fixture data for the GitHub UI browser test.",
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

export function fixtureResponse(prompt: string, generationId: string): string {
  return "<a2ui-json>" + JSON.stringify(fixtureMessages(prompt, generationId)) + "</a2ui-json>";
}

export const generateImmediateText: GenerateText = async function* (request) {
  const text = fixtureResponse(request.prompt, request.generationId);
  for (let offset = 0; offset < text.length; offset += 37) yield text.slice(offset, offset + 37);
};

export const generateFixtureText: GenerateText = async function* (request, signal) {
  const text = fixtureResponse(request.prompt, request.generationId);

  for (let offset = 0; offset < text.length; offset += 160) {
    await pause(45, undefined, { signal });
    yield text.slice(offset, offset + 160);
  }
};
