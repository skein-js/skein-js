import { A2uiGenerator, CatalogConfig, DirectJsonFormatFactory } from "@a2ui/agent";
import { basicCatalog } from "@a2ui/web_core/v1_0";

import type { GenerateText } from "./generation.js";
import {
  messageSurfaceId,
  parseUiMessage,
  snapshotSurfaces,
  uiSurfaceIds,
  validateGeneratedUi,
  type RendererMetadata,
  type SavedUi,
  type UiMessage,
} from "./ui-contract.js";

const generator = new A2uiGenerator(
  [new CatalogConfig(basicCatalog)],
  undefined,
  new DirectJsonFormatFactory({ progressiveKeys: [] }),
);

export async function generateUiUi(options: {
  prompt: string;
  generationId: string;
  metadata: RendererMetadata;
  previousUi: SavedUi | null;
  generateText: GenerateText;
  signal?: AbortSignal;
  writeMessage: (message: UiMessage) => void;
}): Promise<SavedUi> {
  const processor = generator.createProcessor(options.metadata.a2uiRendererCapabilities);
  const stream = processor.openStream();
  const allowedIds = Object.values(uiSurfaceIds(options.generationId));
  const systemPrompt =
    processor.promptSnippet +
    "\n" +
    [
      "Build a general-purpose UI as a complete NEW generation using exactly the three supplied surface IDs: canvas, controls, notes.",
      "Use only Text, Column, Row, Card, Button, TextField and Divider from the Basic Catalog. Text is plain text.",
      "Use only event actions reviseUi (context.prompt is a nonempty UI revision request) and dismissNotes (empty context, on the notes surface).",
      "On controls set sendDataModel:true and dataModel:{feedback:''}. Bind its TextField value to @path:/feedback and its reviseUi context.prompt to that path. Use no other editable data fields.",
      "Include a revision form, a quick revision button, and a Dismiss notes button. No function calls, navigation, custom catalogs, metadata, macros, checks or approval controls.",
      "The host provides review controls. Do not emit remote RPC messages. Create every surface with its root component before updating it.",
    ].join("\n");
  const emit = (parts: ReturnType<typeof stream.feed>) => {
    for (const part of parts) {
      if (part.type !== "a2ui") continue;
      for (const candidate of part.a2ui) {
        const message = parseUiMessage(candidate);
        if (!allowedIds.includes(messageSurfaceId(message)))
          throw new Error("Generated surface belongs to a different UI");
        options.writeMessage(message);
      }
    }
  };
  for await (const text of options.generateText({ ...options, systemPrompt }, options.signal)) {
    options.signal?.throwIfAborted();
    emit(stream.feed(text));
  }
  emit(stream.close());
  options.signal?.throwIfAborted();
  stream.state.checkTopology(stream.state.surfaceIds);
  if (allowedIds.some((id) => !stream.state.getSurface(id)))
    throw new Error("Generated UI is missing a required surface");
  return validateGeneratedUi(
    snapshotSurfaces(
      options.generationId,
      stream.state.surfaceIds.map((id) => stream.state.getSurface(id)!),
    ),
  );
}
