import { RendererState } from "@a2ui/agent";
import { basicCatalog } from "@a2ui/web_core/v1_0";
import {
  Annotation,
  END,
  START,
  StateGraph,
  interrupt,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { z } from "zod";

import { generateDemoText, generateModelText, type GenerateText } from "./generation.js";
import {
  decisionSchema,
  parseSavedUi,
  promptSchema,
  requestSchema,
  snapshotSurfaces,
  tripSurfaceIds,
  type SavedUi,
  type TripRequest,
} from "./trip-contract.js";
import { generateTripUi } from "./trip-generation.js";
import type { UiEvent } from "./ui-events.js";

const TripInput = Annotation.Root({ request: Annotation<TripRequest> });
const TripState = Annotation.Root({
  ...TripInput.spec,
  ui: Annotation<SavedUi | null>({ reducer: (_, next) => next, default: () => null }),
  approved: Annotation<boolean | null>({ reducer: (_, next) => next, default: () => null }),
  prompt: Annotation<string>({ reducer: (_, next) => next, default: () => "" }),
});

export function createTripGraph(generateText: GenerateText = generateDemoText) {
  async function updateTrip(state: typeof TripState.State, config: LangGraphRunnableConfig) {
    const request = requestSchema.parse(state.request);
    let prompt: string;
    if (request.kind === "plan") prompt = request.prompt;
    else {
      if (!state.ui || state.approved === null)
        throw new Error("Review the saved trip before using its actions");
      const saved = parseSavedUi(state.ui);
      if (request.generationId !== saved.generationId)
        throw new Error("This action belongs to an older trip");
      const { action } = request.message;
      const surface = saved.bootstrapMessages.find(
        (message) => message.createSurface.surfaceId === action.surfaceId,
      )?.createSurface;
      const source = surface?.components?.find(
        (component) => component.id === action.sourceComponentId,
      );
      const binding = z
        .object({
          component: z.literal("Button"),
          action: z.object({ event: z.object({ name: z.string() }) }),
        })
        .passthrough()
        .safeParse(source);
      if (!binding.success || binding.data.action.event.name !== action.name)
        throw new Error("Action source does not belong to the saved trip");
      const reportedModels = request.metadata.a2uiRendererDataModel?.surfaces ?? {};
      const preferenceId = tripSurfaceIds(saved.generationId).preferences;
      if (Object.keys(reportedModels).some((id) => id !== preferenceId))
        throw new Error("Unexpected submitted surface data model");
      if (action.name === "dismissTips") {
        if (action.surfaceId !== tripSurfaceIds(saved.generationId).tips)
          throw new Error("Only travel tips can be dismissed");
        z.object({}).strict().parse(action.context);
        const processor = new RendererState([basicCatalog]);
        processor.apply(saved.bootstrapMessages);
        const message = { version: "1.0" as const, deleteSurface: { surfaceId: action.surfaceId } };
        processor.apply(message);
        const ui = snapshotSurfaces(
          saved.generationId,
          processor.surfaceIds.map((id) => processor.getSurface(id)!),
        );
        config.writer?.({
          type: "a2ui",
          generationId: saved.generationId,
          sequence: 0,
          phase: "start",
          operation: "update",
        } satisfies UiEvent);
        config.writer?.({
          type: "a2ui",
          generationId: saved.generationId,
          sequence: 1,
          phase: "message",
          message,
        } satisfies UiEvent);
        config.writer?.({
          type: "a2ui",
          generationId: saved.generationId,
          sequence: 2,
          phase: "complete",
        } satisfies UiEvent);
        return { ui };
      }
      if (action.name !== "reviseTrip") throw new Error("This action is not permitted");
      prompt = z.object({ prompt: promptSchema }).strict().parse(action.context).prompt;
      if (
        action.surfaceId === preferenceId &&
        reportedModels[preferenceId]?.feedback.trim() !== prompt
      )
        throw new Error("The revision does not match the submitted form data");
    }
    const generationId = crypto.randomUUID();
    let sequence = 0;
    const write = (event: UiEvent) => config.writer?.(event);
    write({ type: "a2ui", generationId, sequence: 0, phase: "start", operation: "replace" });
    const ui = await generateTripUi({
      prompt,
      generationId,
      metadata: request.metadata,
      previousUi: state.ui,
      generateText,
      signal: config.signal,
      writeMessage: (message) =>
        write({ type: "a2ui", generationId, sequence: ++sequence, phase: "message", message }),
    });
    write({ type: "a2ui", generationId, sequence: ++sequence, phase: "complete" });
    return { ui, prompt, approved: null };
  }

  function reviewTrip(state: typeof TripState.State) {
    if (!state.ui) throw new Error("Generate a trip before reviewing it");
    const decision = decisionSchema.parse(
      interrupt({ kind: "review-trip", generationId: state.ui.generationId, prompt: state.prompt }),
    );
    if (decision.generationId !== state.ui.generationId)
      throw new Error("This approval belongs to an older trip");
    return { approved: decision.approved };
  }

  return new StateGraph({ stateSchema: TripState, input: TripInput })
    .addNode("update", updateTrip)
    .addNode("review", reviewTrip)
    .addEdge(START, "update")
    .addConditionalEdges("update", (state) => (state.approved === null ? "review" : END))
    .addEdge("review", END)
    .compile();
}

export const graph = createTripGraph((request, signal) =>
  (process.env["A2UI_MODEL"] ? generateModelText : generateDemoText)(request, signal),
);
