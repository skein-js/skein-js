import { A2uiGenerator, CatalogConfig, DirectJsonFormatFactory } from "@a2ui/agent";
import { basicCatalog } from "@a2ui/web_core/v1_0";

import type { GenerateText } from "./generation.js";
import {
  messageSurfaceId,
  parseUiMessage,
  snapshotSurfaces,
  tripSurfaceIds,
  validateGeneratedTrip,
  type RendererMetadata,
  type SavedUi,
  type UiMessage,
} from "./trip-contract.js";

const generator = new A2uiGenerator(
  [new CatalogConfig(basicCatalog)],
  undefined,
  new DirectJsonFormatFactory({ progressiveKeys: [] }),
);

export async function generateTripUi(options: {
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
  const allowedIds = Object.values(tripSurfaceIds(options.generationId));
  const systemPrompt =
    processor.promptSnippet +
    "\n" +
    [
      "Build a trip planner as a complete NEW generation using exactly the three supplied surface IDs: itinerary, preferences, tips.",
      "Use only Text, Column, Row, Card, Button, TextField and Divider from the Basic Catalog. Text is plain text.",
      "Use only event actions reviseTrip (context.prompt is a nonempty revision request) and dismissTips (empty context, on the tips surface).",
      "On preferences set sendDataModel:true and dataModel:{feedback:''}. Bind its TextField value to @path:/feedback and its reviseTrip context.prompt to that path. Use no other editable data fields.",
      "Include a revision form, a quick revision button, and a Dismiss travel tips button. No function calls, navigation, custom catalogs, metadata, macros, checks or approval controls.",
      "The host provides review controls. Do not emit remote RPC messages. Create every surface with its root component before updating it.",
    ].join("\n");
  const emit = (parts: ReturnType<typeof stream.feed>) => {
    for (const part of parts) {
      if (part.type !== "a2ui") continue;
      for (const candidate of part.a2ui) {
        const message = parseUiMessage(candidate);
        if (!allowedIds.includes(messageSurfaceId(message)))
          throw new Error("Generated surface belongs to a different trip");
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
    throw new Error("Generated trip is missing a required surface");
  return validateGeneratedTrip(
    snapshotSurfaces(
      options.generationId,
      stream.state.surfaceIds.map((id) => stream.state.getSurface(id)!),
    ),
  );
}
