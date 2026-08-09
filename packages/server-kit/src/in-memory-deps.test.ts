import { MessagesAnnotation, MemorySaver, StateGraph } from "@langchain/langgraph";
import type { GraphResolver, ProtocolDeps } from "@skein-js/agent-protocol";
import { MemoryRunEventBus, MemoryRunQueue, MemorySkeinStore } from "@skein-js/storage-memory";
import { describe, expect, it } from "vitest";

import {
  createInMemoryDeps,
  embedInMemoryGraphs,
  graphMapToResolver,
  normalizeEmbeddableGraphs,
} from "./in-memory-deps.js";

/** A minimal, real compiled graph — enough to be a valid `ResolvedGraph` map value. */
function buildGraph() {
  return new StateGraph(MessagesAnnotation)
    .addNode("noop", () => ({ messages: [] }))
    .addEdge("__start__", "noop")
    .addEdge("noop", "__end__")
    .compile();
}

describe("graphMapToResolver", () => {
  it("takes ids from the map keys", () => {
    const resolver = graphMapToResolver({ echo: buildGraph(), agent: buildGraph() });
    expect(resolver.ids).toEqual(["echo", "agent"]);
  });

  // `graphMapToResolver` stays a pure normalizer — no runtime binding. Binding happens in
  // `normalizeEmbeddableGraphs`, so it applies to a caller-supplied resolver too (see below).
  it("loads the exact mapped graph (compiled graph or factory, uninvoked)", async () => {
    const echo = buildGraph();
    let factoryCalls = 0;
    const agent = () => {
      factoryCalls += 1;
      return buildGraph();
    };
    const resolver = graphMapToResolver({ echo, agent });

    expect(await resolver.load("echo")).toBe(echo);
    expect(await resolver.load("agent")).toBe(agent);
    expect(factoryCalls).toBe(0);
  });

  it("throws a helpful error for an unknown id", async () => {
    const resolver = graphMapToResolver({ echo: buildGraph() });
    await expect(resolver.load("nope")).rejects.toThrow(/Unknown graph "nope".*known: echo/);
  });

  it("returns the minimal { graph_id } schema stub", async () => {
    const resolver = graphMapToResolver({ echo: buildGraph() });
    expect(await resolver.schemas("echo")).toEqual({ echo: { graph_id: "echo" } });
  });
});

describe("normalizeEmbeddableGraphs", () => {
  it("memoizes the binding, so load() stays identity-stable across calls", async () => {
    const resolver = normalizeEmbeddableGraphs({ echo: buildGraph() });
    expect(await resolver.load("echo")).toBe(await resolver.load("echo"));
  });

  it("turns a graph map into a resolver keyed by the map keys", async () => {
    const echo = buildGraph();
    const resolver = normalizeEmbeddableGraphs({ echo });
    expect(resolver.ids).toEqual(["echo"]);
    expect(Object.getPrototypeOf((await resolver.load("echo")) as object)).toBe(echo);
  });

  // A caller-supplied resolver is bound too. It used to be passed through untouched, which silently
  // broke HITL resume on `embedInMemoryGraphs(myResolver)`: the engine's command envelope reached a
  // real LangGraph graph untranslated, and the resume became a no-op with no error anywhere.
  it("binds a caller-supplied resolver's LangGraph graphs too", async () => {
    const graph = buildGraph();
    const resolver: GraphResolver = {
      ids: ["custom"],
      load: async () => graph,
      schemas: async (id) => ({ [id]: { graph_id: id } }) as never,
    };

    const normalized = normalizeEmbeddableGraphs(resolver);
    expect(Object.getPrototypeOf((await normalized.load("custom")) as object)).toBe(graph);
  });

  // ...but only the LangGraph ones. A hand-written `AgentGraph` must receive the envelope untouched;
  // handing it a `Command` would give it a class it cannot read.
  it("leaves a non-LangGraph AgentGraph alone", async () => {
    const agent = {
      stream: () => (async function* () {})(),
      getState: async () => ({ values: {}, next: [], tasks: [] }),
    };
    const resolver: GraphResolver = {
      ids: ["plain"],
      load: async () => agent,
      schemas: async (id) => ({ [id]: { graph_id: id } }) as never,
    };

    expect(await normalizeEmbeddableGraphs(resolver).load("plain")).toBe(agent);
  });

  it('treats a graph keyed "ids" as a map, not a resolver (the discriminator holds)', async () => {
    // A map whose value is a real graph must not be mistaken for a GraphResolver just because it has an
    // `ids` key — the discriminator checks that `ids` is an array and `load` is a function.
    const graph = buildGraph();
    const resolver = normalizeEmbeddableGraphs({ ids: graph });
    expect(resolver.ids).toEqual(["ids"]);
    expect(Object.getPrototypeOf((await resolver.load("ids")) as object)).toBe(graph);
  });
});

describe("embedInMemoryGraphs", () => {
  it("assembles the four in-memory drivers around a graph map", () => {
    const deps = embedInMemoryGraphs({ echo: buildGraph() });

    expect(deps.store).toBeInstanceOf(MemorySkeinStore);
    expect(deps.queue).toBeInstanceOf(MemoryRunQueue);
    expect(deps.bus).toBeInstanceOf(MemoryRunEventBus);
    expect(deps.checkpointer).toBeInstanceOf(MemorySaver);
    expect(deps.graphs.ids).toEqual(["echo"]);
  });

  it("accepts a ready GraphResolver, binding its graphs like a map's", async () => {
    const graph = buildGraph();
    const resolver: GraphResolver = graphMapToResolver({ custom: graph });
    const deps = embedInMemoryGraphs(resolver);

    expect(deps.graphs.ids).toEqual(["custom"]);
    expect(Object.getPrototypeOf((await deps.graphs.load("custom")) as object)).toBe(graph);
  });

  it("applies overrides — replacing a driver and adding auth, keeping other defaults", () => {
    const queue = new MemoryRunQueue();
    const auth = { authenticate: async () => ({}) } as unknown as ProtocolDeps["auth"];
    const deps = embedInMemoryGraphs({ echo: buildGraph() }, { queue, auth });

    // the overridden fields win…
    expect(deps.queue).toBe(queue);
    expect(deps.auth).toBe(auth);
    // …and the untouched drivers keep their in-memory defaults
    expect(deps.store).toBeInstanceOf(MemorySkeinStore);
    expect(deps.bus).toBeInstanceOf(MemoryRunEventBus);
    expect(deps.checkpointer).toBeInstanceOf(MemorySaver);
  });

  it("throws when a known graph id is present but resolves to a nullish value", async () => {
    // A wrong export name makes a lazy import resolve to `undefined`; the error should point at the
    // value, not claim the id is unknown when it is right there in the map.
    const resolver = graphMapToResolver({ agent: undefined as never });
    await expect(resolver.load("agent")).rejects.toThrow(/Graph "agent" resolved to undefined/);
  });

  it("keeps the deprecated createInMemoryDeps alias pointing at the same function", () => {
    expect(createInMemoryDeps).toBe(embedInMemoryGraphs);
    // and it still assembles deps when called through the old name
    expect(createInMemoryDeps({ echo: buildGraph() }).store).toBeInstanceOf(MemorySkeinStore);
  });
});
