// What `embedInMemoryGraphs` will accept as a graph.
//
// The regression: `EmbeddableGraph` was bound to `CompiledGraph`, which LangChain's own `createAgent`
// does not structurally satisfy — it returns a `ReactAgent`, missing dozens of `CompiledGraph`
// members. So the blessed way to build an agent could not be embedded in code at all, and the only
// example that embeds one rather than loading it from `langgraph.json` failed to compile. Nothing was
// wrong at runtime: `langGraphResolver` casts whatever it is to an `AgentGraph`, which requires only
// `stream` and `getState`.
//
// These are compile-time assertions. They pass by *building*, so a narrowing of the type breaks
// `typecheck` rather than silently rejecting user code again.

import { describe, expect, it } from "vitest";

import { embedInMemoryGraphs, type EmbeddableGraph } from "./in-memory-deps.js";

/** The shape `createAgent` returns: streamable and stateful, but not a `CompiledGraph`. */
const agentLike = {
  stream: async () => (async function* () {})(),
  getState: async () => ({ values: {}, next: [], tasks: [] }),
};

describe("EmbeddableGraph", () => {
  it("accepts what createAgent returns", () => {
    // The assertion is the assignment: this file does not compile if the type narrows back.
    const graph: EmbeddableGraph = agentLike;
    expect(graph).toBe(agentLike);
  });

  it("accepts a factory that builds one per run", () => {
    const factory: EmbeddableGraph = async () => agentLike;
    expect(typeof factory).toBe("function");
  });

  it("embeds one without a cast at the call site", () => {
    // The actual failure mode, reproduced: a user holding a `createAgent` result and calling the
    // documented embedding helper.
    const deps = embedInMemoryGraphs({ agent: agentLike });
    expect(deps.graphs.ids).toContain("agent");
  });
});
