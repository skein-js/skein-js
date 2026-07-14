// Deterministic, API-key-free graphs for the unit suite. A tiny single-string state keeps the
// tests focused on the engine (status transitions, streaming, interrupt/resume, cancellation)
// rather than on message plumbing.

import {
  Annotation,
  type CompiledGraph,
  getStore,
  type LangGraphRunnableConfig,
  interrupt,
  StateGraph,
} from "@langchain/langgraph";

const ValueState = Annotation.Root({
  value: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
});

/** Echoes its input: `{ value: "hi" }` -> `{ value: "echo: hi" }`. Always succeeds. */
export const echoGraph: CompiledGraph<string> = new StateGraph(ValueState)
  .addNode("echo", (state) => ({ value: `echo: ${state.value}` }))
  .addEdge("__start__", "echo")
  .addEdge("echo", "__end__")
  .compile() as unknown as CompiledGraph<string>;

/** Pauses on an interrupt, then resumes with the provided value on the next run. */
export const interruptingGraph: CompiledGraph<string> = new StateGraph(ValueState)
  .addNode("ask", () => {
    const answer = interrupt<string, string>("approve?");
    return { value: `resumed: ${answer}` };
  })
  .addEdge("__start__", "ask")
  .addEdge("ask", "__end__")
  .compile() as unknown as CompiledGraph<string>;

/** Always throws, to exercise the error path (error frame + error status). */
export const throwingGraph: CompiledGraph<string> = new StateGraph(ValueState)
  .addNode("boom", () => {
    throw new Error("boom");
  })
  .addEdge("__start__", "boom")
  .addEdge("boom", "__end__")
  .compile() as unknown as CompiledGraph<string>;

/** Waits until aborted (or ~10s), for cancellation/timeout tests. Rejects promptly on abort. */
export const slowGraph: CompiledGraph<string> = new StateGraph(ValueState)
  .addNode("wait", async (_state, config?: LangGraphRunnableConfig) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 10_000);
      config?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
    return { value: "done" };
  })
  .addEdge("__start__", "wait")
  .addEdge("wait", "__end__")
  .compile() as unknown as CompiledGraph<string>;

/**
 * Writes its input to the injected long-term store via `getStore()`, then reads it back — proves the
 * engine attaches a `BaseStore` to each run (see `SkeinBaseStore`), the way LangGraph Platform does.
 */
export const storeGraph: CompiledGraph<string> = new StateGraph(ValueState)
  .addNode("remember", async (state) => {
    const store = getStore();
    if (!store) throw new Error("expected an injected store");
    await store.put(["memories"], "note", { text: state.value });
    const item = await store.get(["memories"], "note");
    const text = (item?.value as { text?: string } | undefined)?.text ?? "?";
    return { value: `stored: ${text}` };
  })
  .addEdge("__start__", "remember")
  .addEdge("remember", "__end__")
  .compile() as unknown as CompiledGraph<string>;

/** The fixture graphs keyed by graph id, for a test `GraphResolver`. */
export const fixtureGraphs: Record<string, CompiledGraph<string>> = {
  echo: echoGraph,
  interrupting: interruptingGraph,
  throwing: throwingGraph,
  slow: slowGraph,
  store: storeGraph,
};
