// A fixture-local stand-in for `@skein-js/langgraph`'s `langGraphAgent`.
//
// The fixture graphs are real LangGraph graphs, so a run that resumes has to hand them a real
// `Command`. The engine no longer builds one — it emits a branded envelope (`agentCommand`) and
// leaves translation to the binding. This package cannot import that binding: `@skein-js/langgraph`
// depends on `@skein-js/agent-protocol`, so a dependency back makes the Nx task graph circular.
//
// So the fixtures do what any binding does, in a few lines against `@langchain/langgraph` directly.
// If this file and `langGraphAgent` ever disagree, the fixtures stop reflecting production — the
// interrupt/resume tests in `thread-stream-service.test.ts` are what catch that.

import { Command, type CommandParams } from "@langchain/langgraph";

import { agentCommandPayload, isAgentCommand, type AgentCommand } from "../graphs/agent-command.js";
import type { AgentGraph } from "../graphs/agent-graph.js";

function toCommand(envelope: AgentCommand): Command {
  // The whole payload, exactly as `langGraphAgent` does — picking fields here would let the fixtures
  // pass while production dropped one (`command.graph`, say).
  return new Command(agentCommandPayload(envelope) as CommandParams);
}

function toGraphInput(input: unknown): unknown {
  return isAgentCommand(input) ? toCommand(input) : input;
}

/** One wrapper per graph, so `load()` stays identity-stable (tests spy on a loaded graph). */
const wrappers = new WeakMap<object, AgentGraph>();

/** Translate command envelopes on the way into a real LangGraph graph. */
export function fixtureLangGraphAgent(compiled: AgentGraph): AgentGraph {
  const existing = wrappers.get(compiled);
  if (existing) return existing;
  const agent = buildFixtureAgent(compiled);
  wrappers.set(compiled, agent);
  return agent;
}

function buildFixtureAgent(compiled: AgentGraph): AgentGraph {
  const wrapped = Object.create(compiled) as AgentGraph;
  const { stream, streamEvents, invoke, bulkUpdateState } = compiled;

  // Each override delegates with `this`, not the object captured here — the engine clones this again
  // to attach a per-call checkpointer, and binding to the capture would ignore it.
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
    wrapped.bulkUpdateState = function (
      this: AgentGraph,
      config: { configurable?: Record<string, unknown> },
      supersteps: unknown,
    ) {
      const translated = Array.isArray(supersteps)
        ? supersteps.map((superstep: { updates?: unknown }) =>
            superstep && Array.isArray(superstep.updates)
              ? {
                  ...superstep,
                  updates: superstep.updates.map((update: { values?: unknown }) =>
                    update && isAgentCommand(update.values)
                      ? { ...update, values: toCommand(update.values) }
                      : update,
                  ),
                }
              : superstep,
          )
        : supersteps;
      return bulkUpdateState.call(this, config, translated);
    };
  }
  return wrapped;
}
