import { MessagesAnnotation, MemorySaver, StateGraph } from "@langchain/langgraph";
import type { GraphResolver, ProtocolDeps } from "@skein-js/agent-protocol";
import { MemoryRunEventBus, MemoryRunQueue, MemorySkeinStore } from "@skein-js/storage-memory";
import { describe, expect, it } from "vitest";

import { createInMemoryDeps, graphMapToResolver } from "./in-memory-deps.js";

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

  it("loads the exact mapped graph (compiled graph or factory, uninvoked)", async () => {
    const echo = buildGraph();
    const agent = () => buildGraph(); // a CompiledGraphFactory — returned as-is, not called
    const resolver = graphMapToResolver({ echo, agent });

    expect(await resolver.load("echo")).toBe(echo);
    expect(await resolver.load("agent")).toBe(agent);
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

describe("createInMemoryDeps", () => {
  it("assembles the four in-memory drivers around a graph map", () => {
    const deps = createInMemoryDeps({ echo: buildGraph() });

    expect(deps.store).toBeInstanceOf(MemorySkeinStore);
    expect(deps.queue).toBeInstanceOf(MemoryRunQueue);
    expect(deps.bus).toBeInstanceOf(MemoryRunEventBus);
    expect(deps.checkpointer).toBeInstanceOf(MemorySaver);
    expect(deps.graphs.ids).toEqual(["echo"]);
  });

  it("passes a ready GraphResolver through untouched", async () => {
    const graph = buildGraph();
    const resolver: GraphResolver = graphMapToResolver({ custom: graph });
    const deps = createInMemoryDeps(resolver);

    expect(deps.graphs).toBe(resolver);
    expect(await deps.graphs.load("custom")).toBe(graph);
  });

  it("applies overrides — replacing a driver and adding auth, keeping other defaults", () => {
    const queue = new MemoryRunQueue();
    const auth = { authenticate: async () => ({}) } as unknown as ProtocolDeps["auth"];
    const deps = createInMemoryDeps({ echo: buildGraph() }, { queue, auth });

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
});
