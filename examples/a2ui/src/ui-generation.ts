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

export async function generateA2ui(options: {
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
      "Build a complete new GitHub UI using exactly the three surface IDs in rendererContext.surfaceIds: canvas, controls, notes.",
      "Use only Text, Column, Row, Card, Button, TextField and Divider from the Basic Catalog. Text is plain text.",
      "Use the canonical login or owner/name in the canvas heading so follow-up requests can refer to it.",
      "Create each surface with a root Column and include its controls below. Put the Button IDs in the Column children and define each Button's child as a Text label on the same surface.",
      'canvas includes a quick revise Button with action {"event":{"name":"reviseUi","context":{"prompt":"Make this GitHub view simpler"}}}.',
      'controls has sendDataModel:true and dataModel:{"feedback":""}. Include a TextField with value {"@path":"/feedback"} and a separate submit Button with action {"event":{"name":"reviseUi","context":{"prompt":{"@path":"/feedback"}}}}.',
      'notes includes a Dismiss notes Button with action {"event":{"name":"dismissNotes","context":{}}}.',
      "All three Buttons are required even when rendering an error or asking the user for a target. Event objects contain only name and context. Only controls has editable state.",
      "The host provides review controls. Omit function calls, navigation, custom catalogs, metadata, macros, and checks.",
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
