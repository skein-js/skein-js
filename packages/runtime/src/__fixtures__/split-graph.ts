import { Annotation, StateGraph, type LangGraphRunnableConfig } from "@langchain/langgraph";

/** A real graph whose output proves which process and principal executed it. */
export function buildSplitGraph() {
  return new StateGraph(
    Annotation.Root({
      value: Annotation<string>,
      delay: Annotation<number>,
      caller: Annotation<string>,
      ownerPid: Annotation<number>,
    }),
  )
    .addNode("work", async (state, config: LangGraphRunnableConfig) => {
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          config.signal?.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(finish, state.delay ?? 50);
        const abort = () => {
          clearTimeout(timer);
          reject(config.signal?.reason);
        };
        config.signal?.addEventListener("abort", abort, { once: true });
        if (config.signal?.aborted) abort();
      });
      return {
        caller: String(config.configurable?.["langgraph_auth_user_id"]),
        ownerPid: process.pid,
      };
    })
    .addEdge("__start__", "work")
    .addEdge("work", "__end__")
    .compile();
}
