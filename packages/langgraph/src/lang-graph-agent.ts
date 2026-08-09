// Present a LangGraph.js compiled graph as an `AgentGraph`.
//
// The only translation needed is the run input: the engine hands agents a branded command envelope
// (`agentCommand`) instead of constructing LangGraph's `Command` itself, because `new Command(...)`
// is a *runtime* import of `@langchain/langgraph` — exactly what would put a graph runtime back into
// `@skein-js/agent-protocol`'s install. Everything else about a compiled graph already satisfies
// `AgentGraph` structurally.
//
// This imports only agent-protocol's public entry point — the rule docs/proposals/inbound-events.md
// sets for `EventSource`. If it ever needs an internal, the internal is missing from the public API.

import { Command, type CommandParams } from "@langchain/langgraph";
import { agentCommandPayload, isAgentCommand, type AgentGraph } from "@skein-js/agent-protocol";

/**
 * Whether `value` is a LangGraph compiled graph, as opposed to some other `AgentGraph`.
 *
 * The same duck-test `@skein-js/config`'s `isCompiledGraphLike` uses. It matters because translating
 * a command envelope into a `Command` is only correct for a LangGraph runtime — do it to a
 * hand-written agent and it receives a class it cannot read, which is why wrapping has to be
 * conditional rather than applied to whatever a resolver returns.
 */
export function isLangGraphCompiled(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "builder" in value &&
    typeof (value as { builder: unknown }).builder === "object" &&
    (value as { builder: unknown }).builder !== null
  );
}

/**
 * Translate the engine's input into LangGraph's: a branded command envelope becomes a real `Command`.
 * Anything else is the graph's own input and passes through untouched.
 */
function toGraphInput(input: unknown): unknown {
  if (!isAgentCommand(input)) return input;
  // The **whole** payload, not a hand-picked subset: the wire schema passes unknown fields through,
  // and `CommandParams` carries more than resume/update/goto (`graph` selects a subgraph). Picking
  // fields here would silently drop those. `agentCommandPayload` also strips skein's brand, which a
  // spread would otherwise leak into LangGraph's state.
  return new Command(agentCommandPayload(input) as CommandParams);
}

/** Translate any command envelope sitting in a superstep update's `values` slot. */
function toGraphSupersteps(supersteps: unknown): unknown {
  if (!Array.isArray(supersteps)) return supersteps;
  return supersteps.map((superstep: { updates?: unknown }) => {
    if (!superstep || !Array.isArray(superstep.updates)) return superstep;
    return {
      ...superstep,
      updates: superstep.updates.map((update: { values?: unknown }) =>
        update && isAgentCommand(update.values)
          ? { ...update, values: toGraphInput(update.values) }
          : update,
      ),
    };
  });
}

/**
 * Wrap `compiled` so command envelopes are translated on the way in.
 *
 * The overrides go on a **prototype clone**, never the compiled graph itself: a non-factory export is
 * memoized by the resolver, so every caller shares one instance and writing to it would leak one
 * call's state to another.
 *
 * Each override delegates with `this`, **not** the clone captured here. That matters because the
 * engine clones this result again to attach a per-call checkpointer and store
 * (`resolveCompiledGraph`); binding to the captured object would run the graph against *this*
 * object's attachments and silently ignore the per-call ones — writing thread state to the wrong
 * checkpointer.
 */
export function langGraphAgent(compiled: AgentGraph): AgentGraph {
  const wrapped = Object.create(compiled) as AgentGraph;
  const { stream, streamEvents, invoke, bulkUpdateState } = compiled;

  wrapped.stream = function (this: AgentGraph, input: unknown, options?: unknown) {
    return stream.call(this, toGraphInput(input), options);
  };
  if (streamEvents) {
    wrapped.streamEvents = function (this: AgentGraph, input: unknown, options?: unknown) {
      return streamEvents.call(this, toGraphInput(input), options);
    };
  }
  if (invoke) {
    wrapped.invoke = function (this: AgentGraph, input: unknown, options?: unknown) {
      return invoke.call(this, toGraphInput(input), options);
    };
  }
  if (bulkUpdateState) {
    // Superstep seeding carries a command in each update's `values` slot rather than as the call's
    // input, so it needs its own conversion — the envelope is nested two levels down.
    wrapped.bulkUpdateState = function (
      this: AgentGraph,
      config: { configurable?: Record<string, unknown> },
      supersteps: unknown,
    ) {
      return bulkUpdateState.call(this, config, toGraphSupersteps(supersteps));
    };
  }
  return wrapped;
}
