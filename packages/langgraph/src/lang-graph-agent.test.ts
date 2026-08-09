// Regression cover for the binding itself.
//
// Until this existed, nothing imported `langGraphAgent`: `@skein-js/agent-protocol`'s interrupt/resume
// tests run against `__fixtures__/lang-graph-binding.ts`, a *duplicate* of this translation that the
// engine package needs because depending on this one would make the Nx graph circular. So breaking the
// real binding left every suite green while human-in-the-loop resume silently no-opped in production.
//
// Everything here drives a real compiled graph through the real binding.

import { Annotation, interrupt, StateGraph } from "@langchain/langgraph";
import { agentCommand, type AgentGraph } from "@skein-js/agent-protocol";
import { describe, expect, it } from "vitest";

import { isLangGraphCompiled, langGraphAgent } from "./lang-graph-agent.js";
import { langGraphResolver } from "./lang-graph-resolver.js";

const State = Annotation.Root({
  value: Annotation<string>({ reducer: (_previous, next) => next, default: () => "start" }),
});

/** Pauses once, then records whatever the resume carried. */
function buildInterruptingGraph(): AgentGraph {
  return new StateGraph(State)
    .addNode("ask", () => ({ value: `got:${String(interrupt("approve?"))}` }))
    .addEdge("__start__", "ask")
    .compile({ checkpointer: undefined });
}

async function drain(stream: AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>) {
  const chunks: unknown[] = [];
  for await (const chunk of await stream) chunks.push(chunk);
  return chunks;
}

describe("langGraphAgent", () => {
  it("translates a command envelope into a real Command, so resume reaches the graph", async () => {
    // A stand-in graph that reports what its `stream` was actually handed. Using a spy rather than a
    // real run keeps the assertion on the *translation*, which is the part that regressed.
    let received: unknown;
    const spy: AgentGraph = {
      stream(input) {
        received = input;
        return (async function* () {})();
      },
      async getState() {
        return { values: {}, next: [], tasks: [] };
      },
    };
    // `builder` is what marks a compiled graph; without it the binding correctly declines to wrap.
    const compiled = Object.assign(spy, { builder: {} });

    await drain(langGraphAgent(compiled).stream(agentCommand({ resume: "yes" })));

    // Not the envelope — a real Command, which is what LangGraph's runtime reads.
    expect(received).not.toBeNull();
    expect(received?.constructor?.name).toBe("Command");
    expect(received).toMatchObject({ resume: "yes" });
  });

  // The regression the review caught: picking `resume`/`update`/`goto` off the envelope silently
  // dropped every other field. `command.graph` selects a subgraph, so dropping it sent the resume to
  // the wrong graph — a wrong answer rather than an error.
  it("carries every command field through, not just resume/update/goto", async () => {
    let received: Record<string, unknown> | undefined;
    const compiled = Object.assign(
      {
        stream(input: unknown) {
          received = input as Record<string, unknown>;
          return (async function* () {})();
        },
        async getState() {
          return { values: {}, next: [], tasks: [] };
        },
      } satisfies AgentGraph,
      { builder: {} },
    );

    await drain(
      langGraphAgent(compiled).stream(agentCommand({ resume: "yes", goto: "next", graph: "sub" })),
    );

    // `graph` is the one that regressed — dropping it sends the resume to the wrong subgraph.
    // `goto` is asserted as an array because `Command` normalizes a single node into one; that is
    // LangGraph's shape, and encoding it here is what makes this a test of the real binding.
    expect(received).toMatchObject({ resume: "yes", goto: ["next"], graph: "sub" });
  });

  it("leaves a non-command input untouched", async () => {
    let received: unknown;
    const compiled = Object.assign(
      {
        stream(input: unknown) {
          received = input;
          return (async function* () {})();
        },
        async getState() {
          return { values: {}, next: [], tasks: [] };
        },
      } satisfies AgentGraph,
      { builder: {} },
    );

    await drain(langGraphAgent(compiled).stream({ value: "hello" }));

    expect(received).toEqual({ value: "hello" });
  });

  // The binding must not bind `this` to its own clone: the engine clones the result again to attach a
  // per-call checkpointer, and capturing would run the graph against the wrong one — writing thread
  // state to a discarded saver, silently.
  it("delegates with `this`, so a later clone's attachments win", async () => {
    let seenCheckpointer: unknown;
    const compiled = Object.assign(
      {
        stream(this: { checkpointer?: unknown }) {
          seenCheckpointer = this.checkpointer;
          return (async function* () {})();
        },
        async getState() {
          return { values: {}, next: [], tasks: [] };
        },
      } satisfies AgentGraph,
      { builder: {} },
    );

    const bound = langGraphAgent(compiled);
    // What `resolveCompiledGraph` does per call.
    const perCall = Object.create(bound) as AgentGraph & { checkpointer?: unknown };
    perCall.checkpointer = "per-call-saver";

    await drain(perCall.stream({}));

    expect(seenCheckpointer).toBe("per-call-saver");
  });
});

describe("isLangGraphCompiled", () => {
  it("recognises a real compiled graph and rejects a hand-written agent", () => {
    expect(isLangGraphCompiled(buildInterruptingGraph())).toBe(true);
    expect(
      isLangGraphCompiled({
        stream: () => (async function* () {})(),
        getState: async () => ({ values: {}, next: [], tasks: [] }),
      }),
    ).toBe(false);
    expect(isLangGraphCompiled(null)).toBe(false);
    expect(isLangGraphCompiled("nope")).toBe(false);
  });
});

describe("langGraphResolver", () => {
  // The bug this guards: a caller-supplied resolver used to be passed through unwrapped, so the
  // envelope reached a real graph untranslated and HITL resume became a silent no-op.
  it("binds a LangGraph graph a resolver hands back", async () => {
    const graph = buildInterruptingGraph();
    const resolved = await langGraphResolver({
      ids: ["hitl"],
      load: async () => graph,
      schemas: async (id) => ({ [id]: { graph_id: id } }) as never,
    }).load("hitl");

    expect(resolved).not.toBe(graph);
    expect(Object.getPrototypeOf(resolved as object)).toBe(graph);
  });

  // ...and the converse, which is why the binding is conditional: a hand-written agent must receive
  // the envelope, not a `Command` it has no way to read.
  it("returns a non-LangGraph agent untouched", async () => {
    const agent: AgentGraph = {
      stream: () => (async function* () {})(),
      getState: async () => ({ values: {}, next: [], tasks: [] }),
    };
    const resolved = await langGraphResolver({
      ids: ["plain"],
      load: async () => agent,
      schemas: async (id) => ({ [id]: { graph_id: id } }) as never,
    }).load("plain");

    expect(resolved).toBe(agent);
  });

  it("memoizes, so load() stays identity-stable", async () => {
    const graph = buildInterruptingGraph();
    const resolver = langGraphResolver({
      ids: ["hitl"],
      load: async () => graph,
      schemas: async (id) => ({ [id]: { graph_id: id } }) as never,
    });

    expect(await resolver.load("hitl")).toBe(await resolver.load("hitl"));
  });

  it("tracks a resolver whose ids change, rather than pinning them at wrap time", () => {
    let ids = ["a"];
    const resolver = langGraphResolver({
      get ids() {
        return ids;
      },
      load: async () => buildInterruptingGraph(),
      schemas: async (id) => ({ [id]: { graph_id: id } }) as never,
    });

    ids = ["a", "b"];
    expect(resolver.ids).toEqual(["a", "b"]);
  });
});
