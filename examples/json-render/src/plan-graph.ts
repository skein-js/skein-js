import { createSpecStreamCompiler, type Spec } from "@json-render/core";
import {
  Annotation,
  END,
  interrupt,
  START,
  StateGraph,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";

import {
  decisionSchema,
  requestSchema,
  validateUiSpec,
  type CommittedUi,
  type PlanRequest,
} from "./catalog.js";
import { generateDemoText, generateModelText, type GenerateText } from "./generation.js";
import type { UiEvent } from "./ui-events.js";

const PlanInput = Annotation.Root({ request: Annotation<PlanRequest> });
const PlanState = Annotation.Root({
  ...PlanInput.spec,
  ui: Annotation<CommittedUi | null>({ reducer: (_, next) => next, default: () => null }),
  approved: Annotation<boolean | null>({ reducer: (_, next) => next, default: () => null }),
});

export function createPlanGraph(generateText: GenerateText = generateDemoText) {
  async function generateUi(state: typeof PlanState.State, config: LangGraphRunnableConfig) {
    const request = requestSchema.parse(state.request);
    const compiler = createSpecStreamCompiler<Spec>();
    const generationId = crypto.randomUUID();
    let sequence = 0;
    const write = (event: UiEvent) => config.writer?.(event);
    write({ type: "json-render", generationId, sequence: 0, phase: "start" });
    for await (const text of generateText(request, config.signal, state.ui)) {
      config.signal?.throwIfAborted();
      compiler.push(text);
      write({ type: "json-render", generationId, sequence: ++sequence, phase: "chunk", text });
    }
    config.signal?.throwIfAborted();
    const spec = validateUiSpec(compiler.getResult());
    const ui = { spec, generationId, chunkCount: sequence };
    write({ type: "json-render", generationId, sequence: sequence + 1, phase: "complete" });
    return { ui, approved: null };
  }

  function reviewPlan(state: typeof PlanState.State) {
    if (!state.ui) throw new Error("Generate a plan before reviewing it");
    const decision = decisionSchema.parse(
      interrupt({
        kind: "review-plan",
        generationId: state.ui.generationId,
        prompt: state.request.prompt,
      }),
    );
    if (decision.generationId !== state.ui.generationId)
      throw new Error("This approval belongs to an older plan");
    return { approved: decision.approved };
  }

  return new StateGraph({ stateSchema: PlanState, input: PlanInput })
    .addNode("generate", generateUi)
    .addNode("review", reviewPlan)
    .addEdge(START, "generate")
    .addEdge("generate", "review")
    .addEdge("review", END)
    .compile();
}

export const graph = createPlanGraph((request, signal, previousUi) =>
  (process.env["JSON_RENDER_MODEL"] ? generateModelText : generateDemoText)(
    request,
    signal,
    previousUi,
  ),
);
