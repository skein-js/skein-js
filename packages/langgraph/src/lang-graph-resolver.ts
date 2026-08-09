// Wrap a `GraphResolver` so everything it loads is presented as an `AgentGraph`.
//
// This is the single line every on-ramp adds. `@skein-js/agent-protocol` resolves a `graph_id` to
// "something the engine can drive"; this makes LangGraph.js compiled graphs that, by translating the
// command envelope on the way in (see `langGraphAgent`).

import type { AgentGraph, GraphResolver, ResolvedGraph } from "@skein-js/agent-protocol";

import { isLangGraphCompiled, langGraphAgent } from "./lang-graph-agent.js";

/**
 * One wrapper per underlying graph.
 *
 * `load` is memoized by the resolvers this wraps, so without this every call would allocate a fresh
 * wrapper for the same compiled graph — and, more visibly, `load()` would stop being identity-stable,
 * which callers (and tests that spy on a loaded graph) reasonably rely on. Weak, so a reloaded graph
 * is collectable.
 */
const wrappers = new WeakMap<object, AgentGraph>();

function wrapOnce(graph: AgentGraph): AgentGraph {
  // Only LangGraph graphs are translated. A resolver may legitimately front a hand-written
  // `AgentGraph`, which must receive the command envelope untouched — turning it into a `Command`
  // would hand it a class it cannot read. Conditional here rather than at the call sites so every
  // on-ramp can wrap unconditionally and none of them has to know which kind it holds.
  if (!isLangGraphCompiled(graph)) return graph;
  const existing = wrappers.get(graph);
  if (existing) return existing;
  const wrapped = langGraphAgent(graph);
  wrappers.set(graph, wrapped);
  return wrapped;
}

/**
 * A `GraphResolver` whose graphs are wrapped with {@link langGraphAgent}.
 *
 * `ids` and `schemas` pass straight through — only `load` is affected, and a *factory* export is
 * wrapped per call so a factory that branches on the run's `configurable` still does.
 *
 * Safe to apply to any resolver: a graph that is not a LangGraph compiled graph is returned as-is.
 */
export function langGraphResolver(resolver: GraphResolver): GraphResolver {
  return {
    get ids() {
      // A getter, not a copy: `buildRuntime`'s reroutable resolver swaps its backing registry on
      // `reloadGraphs()`, and a snapshot taken here would pin the ids to boot time.
      return resolver.ids;
    },
    load: async (graphId): Promise<ResolvedGraph> => {
      const resolved = await resolver.load(graphId);
      if (typeof resolved === "function") {
        return async (config: { configurable?: Record<string, unknown> }) =>
          wrapOnce((await resolved(config)) as AgentGraph);
      }
      return wrapOnce(resolved as AgentGraph);
    },
    schemas: (graphId) => resolver.schemas(graphId),
  };
}
