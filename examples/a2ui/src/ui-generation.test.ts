import { basicCatalog, MessageProcessor } from "@a2ui/web_core/v1_0";
import { describe, expect, it } from "vitest";

import { fixtureMessages, generateImmediateText, rendererMetadata } from "./generation-fixture.js";
import type { GenerateText } from "./generation.js";
import { parseSavedUi, parseUiMessage, type UiMessage } from "./ui-contract.js";
import { createUiStream } from "./ui-events.js";
import { generateA2ui } from "./ui-generation.js";

describe("upstream A2UI generation and checkpoint bootstrap", () => {
  it.each([
    "Build a dashboard for skein-js/skein-js",
    "Show the GitHub profile for @octocat",
    "List recently pushed repositories for @torvalds",
  ])("compiles fragmented %s output, restores surfaces and applies a deletion", async (prompt) => {
    const messages: UiMessage[] = [];
    const generationId = crypto.randomUUID();

    const saved = await generateA2ui({
      prompt,
      generationId,
      metadata: rendererMetadata(),
      previousUi: null,
      generateText: generateImmediateText,
      writeMessage: (message) => messages.push(message),
    });
    expect(messages.some((message) => "updateComponents" in message)).toBe(true);
    expect(messages.some((message) => "updateDataModel" in message)).toBe(true);
    expect(saved.bootstrapMessages).toHaveLength(3);
    expect(parseSavedUi(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    const processor = new MessageProcessor([basicCatalog]);

    try {
      processor.processMessages(saved.bootstrapMessages);
      expect(processor.getSurfaces().size).toBe(3);
      processor.processMessages({
        version: "1.0",
        deleteSurface: { surfaceId: generationId + ":notes" },
      });
      expect(processor.getSurfaces().size).toBe(2);
    } finally {
      processor.dispose();
    }
  });

  it("uses contiguous app sequences, drops duplicates and isolates graph scopes", async () => {
    const generationId = crypto.randomUUID();
    const messages: UiMessage[] = [];

    const saved = await generateA2ui({
      prompt: "A quiet city break",
      generationId,
      metadata: rendererMetadata(),
      previousUi: null,
      generateText: generateImmediateText,
      writeMessage: (message) => messages.push(message),
    });

    const stream = createUiStream(null);

    try {
      stream.push({ event: "custom|nested", data: { type: "a2ui", phase: "broken" } });
      const frames = [
        { type: "a2ui", generationId, sequence: 0, phase: "start", operation: "replace" },
        ...messages.map((message, index) => ({
          type: "a2ui",
          generationId,
          sequence: index + 1,
          phase: "message",
          message,
        })),
        { type: "a2ui", generationId, sequence: messages.length + 1, phase: "complete" },
      ];

      for (const frame of frames) {
        stream.push({ event: "custom", data: frame });
        stream.push({ event: "custom", data: frame });
      }

      expect(stream.snapshot()).toMatchObject({ complete: true, gap: false, view: saved });
    } finally {
      stream.dispose();
    }
  });

  it("rejects a generated form that cannot submit the supported feedback action", async () => {
    const withoutBinding: GenerateText = async function* (request) {
      const messages = fixtureMessages(request.prompt, request.generationId);

      const text = JSON.stringify(messages).replace(
        '"sendDataModel":true',
        '"sendDataModel":false',
      );
      yield "<a2ui-json>" + text + "</a2ui-json>";
    };

    await expect(
      generateA2ui({
        prompt: "A quiet city break",
        generationId: crypto.randomUUID(),
        metadata: rendererMetadata(),
        previousUi: null,
        generateText: withoutBinding,
        writeMessage: () => undefined,
      }),
    ).rejects.toThrow("controls surface");
  });

  it("abandons a damaged preview and rejects incompatible snapshots and executable actions", () => {
    const stream = createUiStream(null);

    try {
      stream.push({
        event: "custom",
        data: { type: "a2ui", generationId: crypto.randomUUID(), sequence: 3, phase: "complete" },
      });
      expect(stream.snapshot()).toMatchObject({ gap: true, view: null });
      expect(() => parseSavedUi({ schemaVersion: 2 })).toThrow("New chat");
      expect(() =>
        parseUiMessage({
          version: "1.0",
          createSurface: {
            surfaceId: "bad",
            catalogId: basicCatalog.id,
            components: [
              {
                id: "root",
                component: "Button",
                child: "label",
                action: {
                  functionCall: { "@call": "openUrl", args: { url: "https://example.com" } },
                },
              },
            ],
            dataModel: {},
          },
        }),
      ).toThrow();
    } finally {
      stream.dispose();
    }
  });
});
