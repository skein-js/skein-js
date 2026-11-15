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
  uiSurfaceIds,
  type SavedUi,
  type UiRequest,
} from "./ui-contract.js";
import type { UiEvent } from "./ui-events.js";
import { generateUiUi } from "./ui-generation.js";

const UiInput = Annotation.Root({ request: Annotation<UiRequest> });
const UiState = Annotation.Root({
  ...UiInput.spec,
  ui: Annotation<SavedUi | null>({ reducer: (_, next) => next, default: () => null }),
  conversation: Annotation<{ generationId: string; prompt: string }[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
  approved: Annotation<boolean | null>({ reducer: (_, next) => next, default: () => null }),
  prompt: Annotation<string>({ reducer: (_, next) => next, default: () => "" }),
});

export function createUiGraph(generateText: GenerateText = generateDemoText) {
  async function updateUi(state: typeof UiState.State, config: LangGraphRunnableConfig) {
    const request = requestSchema.parse(state.request);
    let prompt: string;
    if (request.kind === "generate") prompt = request.prompt;
    else {
      if (!state.ui || state.approved === null)
        throw new Error("Review the saved UI before using its actions");
      const saved = parseSavedUi(state.ui);
      if (request.generationId !== saved.generationId)
        throw new Error("This action belongs to an older UI");
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
        throw new Error("Action source does not belong to the saved UI");
      const reportedModels = request.metadata.a2uiRendererDataModel?.surfaces ?? {};
      const preferenceId = uiSurfaceIds(saved.generationId).controls;
      if (Object.keys(reportedModels).some((id) => id !== preferenceId))
        throw new Error("Unexpected submitted surface data model");
      if (action.name === "dismissNotes") {
        if (action.surfaceId !== uiSurfaceIds(saved.generationId).notes)
          throw new Error("Only travel notes can be dismissed");
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
      if (action.name !== "reviseUi") throw new Error("This action is not permitted");
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
    const ui = await generateUiUi({
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
    return {
      ui,
      prompt,
      approved: null,
      conversation: [...state.conversation, { generationId, prompt }],
    };
  }

  function reviewUi(state: typeof UiState.State) {
    if (!state.ui) throw new Error("Generate a UI before reviewing it");
    const decision = decisionSchema.parse(
      interrupt({ kind: "review-ui", generationId: state.ui.generationId, prompt: state.prompt }),
    );
    if (decision.generationId !== state.ui.generationId)
      throw new Error("This approval belongs to an older UI");
    return { approved: decision.approved };
  }

  return new StateGraph({ stateSchema: UiState, input: UiInput })
    .addNode("update", updateUi)
    .addNode("review", reviewUi)
    .addEdge(START, "update")
    .addConditionalEdges("update", (state) => (state.approved === null ? "review" : END))
    .addEdge("review", END)
    .compile();
}

export const graph = createUiGraph((request, signal) =>
  (process.env["A2UI_MODEL"] ? generateModelText : generateDemoText)(request, signal),
);
