import { AIMessage } from "@langchain/core/messages";
import { tool, type ToolRuntime } from "@langchain/core/tools";
import {
  Annotation,
  Command,
  END,
  interrupt,
  Send,
  START,
  StateGraph,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";

import { generateModelText, type GenerateText } from "./generation.js";
import {
  decisionSchema,
  parseSavedUi,
  promptSchema,
  requestSchema,
  uiSurfaceIds,
  type Conversation,
  type SavedUi,
  type UiMessage,
  type UiRequest,
} from "./ui-contract.js";
import type { UiEvent } from "./ui-events.js";
import { generateA2ui } from "./ui-generation.js";

const UiInput = Annotation.Root({ request: Annotation<UiRequest> });

const UiState = Annotation.Root({
  ...UiInput.spec,
  ui: Annotation<SavedUi | null>({ reducer: (_, next) => next, default: () => null }),
  conversation: Annotation<Conversation>({
    reducer: (_, next) => next,
    default: () => [],
  }),
  approved: Annotation<boolean | null>({ reducer: (_, next) => next, default: () => null }),
  prompt: Annotation<string>({ reducer: (_, next) => next, default: () => "" }),
});

const revisionSchema = z.object({ prompt: promptSchema }).strict();

const reviseUi = tool(
  ({ prompt }, { state }: ToolRuntime<typeof UiState.State>) =>
    new Command({
      goto: new Send("update", {
        ui: state.ui,
        conversation: state.conversation,
        request: { kind: "generate", prompt, metadata: state.request.metadata },
      }),
    }),
  {
    name: "reviseUi",
    description: "Generate a revised interface from the user's feedback.",
    schema: revisionSchema,
  },
);

const dismissNotes = tool(
  (_input, { state: { ui }, writer }: ToolRuntime<{ ui: SavedUi }>) => {
    const { generationId } = ui;
    const surfaceId = uiSurfaceIds(generationId).notes;

    const savedUi = parseSavedUi({
      ...ui,
      bootstrapMessages: ui.bootstrapMessages.filter(
        (message) => message.createSurface.surfaceId !== surfaceId,
      ),
    });

    const message = { version: "1.0", deleteSurface: { surfaceId } } satisfies UiMessage;
    writer?.({
      type: "a2ui",
      generationId,
      sequence: 0,
      phase: "start",
      operation: "update",
    } satisfies UiEvent);
    writer?.({
      type: "a2ui",
      generationId,
      sequence: 1,
      phase: "message",
      message,
    } satisfies UiEvent);
    writer?.({ type: "a2ui", generationId, sequence: 2, phase: "complete" } satisfies UiEvent);
    return new Command({ update: { ui: savedUi } });
  },
  {
    name: "dismissNotes",
    description: "Remove the notes surface from the current interface.",
    schema: z.object({}).strict(),
  },
);

const routeRequest = (state: typeof UiState.State) => {
  const request = requestSchema.parse(state.request);
  if (request.kind === "generate") return "update" as const;

  if (!state.ui || state.approved === null)
    throw new Error("Review the saved UI before using its actions");
  const ui = parseSavedUi(state.ui);
  if (request.generationId !== ui.generationId)
    throw new Error("This action belongs to an older UI");

  const { action } = request.message;

  const surface = ui.bootstrapMessages.find(
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
    .safeParse(source);
  if (!binding.success || binding.data.action.event.name !== action.name)
    throw new Error("Action source does not belong to the saved UI");

  const { controls, notes } = uiSurfaceIds(ui.generationId);
  const submittedModels = request.metadata.a2uiRendererDataModel?.surfaces ?? {};
  if (Object.keys(submittedModels).some((id) => id !== controls))
    throw new Error("Unexpected submitted surface data model");

  if (action.name === "reviseUi") {
    const { prompt } = revisionSchema.parse(action.context);
    if (action.surfaceId === controls && submittedModels[controls]?.feedback.trim() !== prompt)
      throw new Error("The revision does not match the submitted form data");
  } else if (action.name === "dismissNotes") {
    if (action.surfaceId !== notes) throw new Error("Only the notes surface can be dismissed");
  } else {
    throw new Error("This action is not permitted");
  }

  // A validated renderer event supplies the tool call. Send it only to the tools node.
  return new Send("tools", {
    ui,
    conversation: state.conversation,
    request,
    messages: [
      new AIMessage({
        content: "",
        tool_calls: [{ name: action.name, args: action.context, id: crypto.randomUUID() }],
      }),
    ],
  });
};

const updateUi = async (state: typeof UiState.State, config: LangGraphRunnableConfig) => {
  const request = requestSchema.parse(state.request);
  if (request.kind !== "generate") throw new Error("Expected a UI generation request");
  const generationId = crypto.randomUUID();
  let sequence = 0;
  const write = (event: UiEvent) => config.writer?.(event);
  // Hosts can supply a generator through runtime context. The served example uses the live model.
  const generateText = config.context?.["generateText"] as GenerateText | undefined;
  write({ type: "a2ui", generationId, sequence: 0, phase: "start", operation: "replace" });
  const ui = await generateA2ui({
    prompt: request.prompt,
    generationId,
    metadata: request.metadata,
    previousUi: state.ui,
    generateText: typeof generateText === "function" ? generateText : generateModelText,
    signal: config.signal,
    writeMessage: (message) =>
      write({ type: "a2ui", generationId, sequence: ++sequence, phase: "message", message }),
  });
  write({ type: "a2ui", generationId, sequence: ++sequence, phase: "complete" });
  return {
    ui,
    prompt: request.prompt,
    approved: null,
    conversation: [
      ...state.conversation.map((turn) =>
        turn.generationId === state.ui?.generationId ? { ...turn, ui: state.ui } : turn,
      ),
      { generationId, prompt: request.prompt, ui },
    ],
  };
};

const reviewUi = (state: typeof UiState.State) => {
  if (!state.ui) throw new Error("Generate a UI before reviewing it");
  const decision = decisionSchema.parse(
    interrupt({ kind: "review-ui", generationId: state.ui.generationId, prompt: state.prompt }),
  );
  if (decision.generationId !== state.ui.generationId)
    throw new Error("This approval belongs to an older UI");
  return { approved: decision.approved };
};

export const graph = new StateGraph({ stateSchema: UiState, input: UiInput })
  .addNode("tools", new ToolNode([reviseUi, dismissNotes], { handleToolErrors: false }), {
    ends: ["update"],
  })
  .addNode("update", updateUi)
  .addNode("review", reviewUi)
  .addConditionalEdges(START, routeRequest, ["tools", "update"])
  .addEdge("update", "review")
  .addEdge("review", END)
  .compile();
