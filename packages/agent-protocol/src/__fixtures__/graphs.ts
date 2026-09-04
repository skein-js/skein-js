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

import { replyWith } from "../runs/declared-reply.js";

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

/** Declares its answer on the custom stream via `replyWith`, instead of leaving it in state. */
export const declaringGraph: CompiledGraph<string> = new StateGraph(ValueState)
  .addNode("answer", (state, config) => {
    const writer = (config as { writer?: (chunk: unknown) => void }).writer;
    writer?.(replyWith(`declared: ${state.value}`));
    return { value: "state value nobody should send" };
  })
  .addEdge("__start__", "answer")
  .addEdge("answer", "__end__")
  .compile() as unknown as CompiledGraph<string>;

/** Always throws, to exercise the error path (error frame + error status). */
export const throwingGraph: CompiledGraph<string> = new StateGraph(ValueState)
  .addNode("boom", () => {
    throw new Error("boom");
  })
  .addEdge("__start__", "boom")
  .addEdge("boom", "__end__")
  .compile() as unknown as CompiledGraph<string>;

/** Throws an error that wraps a cause, to exercise the chain-walking in the failure report. */
export const throwingWithCauseGraph: CompiledGraph<string> = new StateGraph(ValueState)
  .addNode("call_model", () => {
    throw new Error("model call failed", { cause: new Error("429 rate limit") });
  })
  .addEdge("__start__", "call_model")
  .addEdge("call_model", "__end__")
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

/**
 * The same round trip as {@link storeGraph}, but through `config.store` instead of `getStore()`.
 *
 * Both are the same object at runtime (LangGraph runs a node with the very config it puts in
 * AsyncLocalStorage), but `config.store` is the accessor the docs lead with, and it was the one no
 * test covered — so an on-ramp that failed to inject `storeBridge` broke the documented pattern
 * silently, since `config.store?.put(...)` on a missing store is a no-op rather than a throw.
 */
export const configStoreGraph: CompiledGraph<string> = new StateGraph(ValueState)
  .addNode("remember", async (state, config: LangGraphRunnableConfig) => {
    const store = config.store;
    if (!store) throw new Error("expected a store on the node's config");
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
  "throwing-with-cause": throwingWithCauseGraph,
  slow: slowGraph,
  store: storeGraph,
  "config-store": configStoreGraph,
};
