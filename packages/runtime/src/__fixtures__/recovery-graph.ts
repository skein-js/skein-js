import { Annotation, StateGraph, type LangGraphRunnableConfig } from "@langchain/langgraph";
import type { ProtocolDeps } from "@skein-js/agent-protocol";

const recoveryState = Annotation.Root({
  total: Annotation<number>({ reducer: (previous, next) => previous + next, default: () => 0 }),
  steps: Annotation<string[]>({
    reducer: (previous, next) => [...previous, ...next],
    default: () => [],
  }),
});

export function buildRecoveryGraph(
  dependencies: () => ProtocolDeps,
  checkpointed?: () => Promise<void>,
) {
  return new StateGraph(recoveryState)
    .addNode("first", async (_state, config: LangGraphRunnableConfig) => {
      const threadId = String(config.configurable?.thread_id);
      const effects = dependencies().store.store;
      const previous = await effects.get(["recovery-effects"], threadId);
      await effects.put(["recovery-effects"], threadId, {
        count: Number(previous?.value["count"] ?? 0) + 1,
      });
      return { total: 10, steps: ["first"] };
    })
    .addNode("second", async () => {
      await checkpointed?.();
      return { total: 100, steps: ["second"] };
    })
    .addEdge("__start__", "first")
    .addEdge("first", "second")
    .addEdge("second", "__end__")
    .compile();
}
