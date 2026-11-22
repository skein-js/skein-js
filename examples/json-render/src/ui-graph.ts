import { createSpecStreamCompiler, type Spec } from "@json-render/core";
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

import {
  decisionSchema,
  promptRequestSchema,
  requestSchema,
  revisionSchema,
  validateGeneratedUi,
  type CommittedUi,
  type Conversation,
  type UiRequest,
} from "./catalog.js";
import { generateModelText, type GenerateText } from "./generation.js";
import type { UiEvent } from "./ui-events.js";

const UiInput = Annotation.Root({ request: Annotation<UiRequest> });

const UiState = Annotation.Root({
  ...UiInput.spec,
  ui: Annotation<CommittedUi | null>({ reducer: (_, next) => next, default: () => null }),
  conversation: Annotation<Conversation>({
    reducer: (_, next) => next,
    default: () => [],
  }),
  approved: Annotation<boolean | null>({ reducer: (_, next) => next, default: () => null }),
});

class InvalidSpecError extends Error {
  constructor(cause: unknown) {
    super("The model returned an invalid UI specification.", { cause });
  }
}

const reviseUi = tool(
  (
    { generationId, prompt },
    { state }: ToolRuntime<Pick<typeof UiState.State, "approved" | "ui">>,
  ) => {
    if (!state.ui || state.approved === null)
      throw new Error("Review the saved UI before using its actions");
    if (state.ui.generationId !== generationId)
      throw new Error("This action belongs to an older UI");

    return new Command({ update: { request: { prompt } }, goto: "generate" });
  },
  {
    name: "reviseUi",
    description: "Generate a revised interface from the user's feedback.",
    schema: revisionSchema,
  },
);

const routeRequest = (state: typeof UiState.State) => {
  const request = requestSchema.parse(state.request);
  if (!("action" in request)) return "generate" as const;

  // Pass the renderer's tool call directly to ToolNode so it stays out of conversation state.
  const { action, ...args } = request;
  return new Send("tools", {
    ui: state.ui,
    approved: state.approved,
    messages: [
      new AIMessage({
        content: "",
        tool_calls: [{ name: action, args, id: crypto.randomUUID() }],
      }),
    ],
  });
};

const generateUi = async (state: typeof UiState.State, config: LangGraphRunnableConfig) => {
  const request = promptRequestSchema.parse(state.request);
  // Tests bind a fixture through runtime context. The hosted graph uses the live model.
  const fixture = config.context?.["generateText"] as GenerateText | undefined;
  const generateText = typeof fixture === "function" ? fixture : generateModelText;
  const compiler = createSpecStreamCompiler<Spec>();
  const generationId = crypto.randomUUID();
  let sequence = 0;
  const write = (event: UiEvent) => config.writer?.(event);
  write({ type: "json-render", generationId, sequence: 0, phase: "start" });

  for await (const text of generateText(request, config.signal, state.ui)) {
    config.signal?.throwIfAborted();

    try {
      compiler.push(text);
    } catch (error) {
      throw new InvalidSpecError(error);
    }

    write({ type: "json-render", generationId, sequence: ++sequence, phase: "chunk", text });
  }

  config.signal?.throwIfAborted();
  let spec: Spec;

  try {
    spec = validateGeneratedUi(compiler.getResult());
  } catch (error) {
    throw new InvalidSpecError(error);
  }

  const ui = { spec, generationId, chunkCount: sequence };
  write({ type: "json-render", generationId, sequence: sequence + 1, phase: "complete" });
  return {
    ui,
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
    interrupt({
      kind: "review-ui",
      generationId: state.ui.generationId,
      prompt: state.request.prompt,
    }),
  );
  if (decision.generationId !== state.ui.generationId)
    throw new Error("This approval belongs to an older UI");
  return { approved: decision.approved };
};

export const graph = new StateGraph({ stateSchema: UiState, input: UiInput })
  .addNode("tools", new ToolNode([reviseUi], { handleToolErrors: false }), { ends: ["generate"] })
  .addNode("generate", generateUi, {
    retryPolicy: { maxAttempts: 2, retryOn: (error) => error instanceof InvalidSpecError },
  })
  .addNode("review", reviewUi)
  .addConditionalEdges(START, routeRequest, ["generate", "tools"])
  .addEdge("generate", "review")
  .addEdge("review", END)
  .compile();
