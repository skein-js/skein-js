// The two assignability facts `AgentGraph` exists to guarantee. Both are compile-time claims, so the
// real assertion is that this file typechecks — the runtime `expect`s only keep vitest honest about
// having run it.
//
// If either direction breaks, the widening in `ResolvedGraph` is not additive and the type is wrong.

import { Annotation, StateGraph } from "@langchain/langgraph";
import { isSkeinHttpError, type SkeinHttpError } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { requireAgentCapability, type AgentGraph, type AgentStateSnapshot } from "./agent-graph.js";

describe("AgentGraph", () => {
  it("accepts a real LangGraph compiled graph, so widening ResolvedGraph stays additive", () => {
    const State = Annotation.Root({
      messages: Annotation<string[]>({
        reducer: (left, right) => [...left, ...right],
        default: () => [],
      }),
    });
    const compiled = new StateGraph(State)
      .addNode("echo", (state) => ({ messages: [...state.messages] }))
      .addEdge("__start__", "echo")
      .compile();

    // The load-bearing line: no cast. If `CompiledGraph` ever stops satisfying `AgentGraph`, this
    // fails to compile and the widening is no longer backwards compatible.
    const asAgent: AgentGraph = compiled;

    expect(typeof asAgent.stream).toBe("function");
    expect(typeof asAgent.getState).toBe("function");
    // LangGraph implements every optional method too.
    expect(typeof asAgent.updateState).toBe("function");
    expect(typeof asAgent.getGraphAsync).toBe("function");
  });

  it("accepts a hand-written agent with only the two required methods and no casts", () => {
    const state: AgentStateSnapshot = {
      values: { messages: [] },
      next: [],
      tasks: [],
    };

    // The reason the type exists: this is what a non-LangGraph runtime writes. Phase 1 needed
    // `as unknown as EmbeddableGraph` here; this asserts that cast is gone. No cast below — that is
    // the whole assertion.
    const handWritten: AgentGraph = {
      stream() {
        return (async function* () {
          yield ["values", state.values];
        })();
      },
      async getState() {
        return state;
      },
      async *getStateHistory() {
        yield state;
      },
    };

    expect(typeof handWritten.stream).toBe("function");
    expect(handWritten.updateState).toBeUndefined();
  });

  it("accepts the minimal two-method object literal directly", () => {
    const minimal: AgentGraph = {
      stream() {
        return (async function* () {
          yield ["values", { ok: true }];
        })();
      },
      async getState() {
        return { values: {}, next: [], tasks: [] };
      },
    };

    expect(minimal.getStateHistory).toBeUndefined();
  });
});

describe("requireAgentCapability", () => {
  const minimal: AgentGraph = {
    stream() {
      return (async function* () {
        yield ["values", {}];
      })();
    },
    async getState() {
      return { values: {}, next: [], tasks: [] };
    },
  };

  it("returns the agent, narrowed, when the capability is present", () => {
    const withUpdate: AgentGraph = {
      ...minimal,
      async updateState() {
        return { configurable: { checkpoint_id: "cp-1" } };
      },
    };

    const narrowed = requireAgentCapability(withUpdate, "updateState");

    expect(narrowed).toBe(withUpdate);
    // The narrowing is the point: `updateState` is non-optional on the result, so callers stop
    // needing a `?.` that would silently skip the write.
    expect(typeof narrowed.updateState).toBe("function");
  });

  // The regression this exists for: calling a missing optional method used to be an unhandled
  // TypeError, which every adapter serialized as a bare 500. Measured against a real server before
  // the fix — `POST /threads/{id}/state` and `GET /assistants/{id}/graph` both returned 500.
  it("throws a 422 naming the capability, not an unhandled TypeError", () => {
    let thrown: unknown;
    try {
      requireAgentCapability(minimal, "updateState");
    } catch (error) {
      thrown = error;
    }

    expect(isSkeinHttpError(thrown)).toBe(true);
    const error = thrown as SkeinHttpError;
    expect(error.status).toBe(422);
    expect(error.code).toBe("agent_capability_missing");
    expect(error.details).toEqual({ capability: "updateState" });
    expect(error.message).toContain("updateState");
  });

  // 422 rather than 501 is load-bearing, not cosmetic: @langchain/langgraph-sdk's AsyncCaller retries
  // anything outside STATUS_NO_RETRY = [400,401,402,403,404,405,406,407,408,409,422]. A 501 would cost
  // the official client five requests and exponential backoff to learn a fact that cannot change.
  it("uses a status the LangGraph SDK will not retry", () => {
    const sdkNoRetry = [400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 422];
    let status: number | undefined;
    try {
      requireAgentCapability(minimal, "getGraphAsync");
    } catch (error) {
      status = (error as SkeinHttpError).status;
    }

    expect(sdkNoRetry).toContain(status);
    expect(status).not.toBe(501);
  });

  it("reports every optional method as a capability, and neither required one", () => {
    for (const capability of ["getStateHistory", "updateState", "getGraphAsync"] as const) {
      expect(() => requireAgentCapability(minimal, capability)).toThrow();
    }
  });
});
