// Assemble a `ProtocolDeps` around graphs you already hold in code — the config-free counterpart to
// `loadInMemoryRuntime` (which reads a `langgraph.json`). This is the public seam for embedding skein
// into an app that never adopted the LangGraph Platform's project shape: bring a compiled graph (or a
// map of them) and get a full Agent Protocol runtime backed by in-process drivers, then hand it to any
// adapter's `{ deps }` seam. Swap any driver via `overrides` (e.g. the Postgres store + Redis queue
// from `@skein-js/runtime`) for a durable, horizontally-scalable deployment. See docs/embedding.md.

import type { CompiledGraph } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph";
import type {
  GraphResolver,
  GraphSchemas,
  ProtocolDeps,
  ResolvedGraph,
} from "@skein-js/agent-protocol";
import { MemoryRunEventBus, MemoryRunQueue, MemorySkeinStore } from "@skein-js/storage-memory";

// The graph's node-name/state generics are left open so a concretely-typed `.compile()` result (e.g.
// from `MessagesAnnotation`) is accepted without a cast at the call site — the engine only drives the
// runnable surface every compiled graph shares, and `graphMapToResolver` widens to the engine's
// `CompiledGraph<string>` internally. This is the one spot the openness is deliberate.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCompiledGraph = CompiledGraph<any>;

/**
 * A graph you can embed in code: any compiled LangGraph.js graph, or a factory that builds one per run
 * (called with the run's `configurable`). Keys of a graph map become graph ids.
 */
export type EmbeddableGraph =
  | AnyCompiledGraph
  | ((config: {
      configurable?: Record<string, unknown>;
    }) => AnyCompiledGraph | Promise<AnyCompiledGraph>);

/**
 * A ready {@link GraphResolver} vs a plain graph map: only the resolver has an `ids` array and a `load`
 * function. A graph map's values are compiled graphs or factories, never an array, so `ids` being an
 * array reliably tells the two apart (even for a graph keyed `"ids"`).
 */
function isGraphResolver(
  graphs: GraphResolver | Record<string, EmbeddableGraph>,
): graphs is GraphResolver {
  const candidate = graphs as GraphResolver;
  return Array.isArray(candidate.ids) && typeof candidate.load === "function";
}

/**
 * Turn a map of compiled graphs (or per-config factories) into a {@link GraphResolver}. Keys become the
 * graph ids — one auto-registered assistant each. `schemas()` returns a minimal `{ graph_id }` stub:
 * enough for the assistants introspection endpoints and everything `useStream` / Agent Chat UI render.
 * Real input/output/state schema extraction stays a `langgraph.json`/config feature — it needs static
 * TypeScript analysis of the graph source, which a compiled graph object no longer carries.
 */
export function graphMapToResolver(graphs: Record<string, EmbeddableGraph>): GraphResolver {
  const ids = Object.keys(graphs);
  return {
    ids,
    load: async (graphId) => {
      const graph = graphs[graphId];
      if (graph == null) {
        const known = ids.join(", ") || "none";
        // Distinguish a genuinely-unknown id from a known key whose value is nullish (e.g. a lazy
        // import that resolved to `undefined` because the export name was wrong) — the latter would
        // otherwise be misreported as "unknown" even though the key is right there in `known`.
        throw new Error(
          ids.includes(graphId)
            ? `Graph "${graphId}" resolved to ${String(graph)} — check its export/factory (known: ${known}).`
            : `Unknown graph "${graphId}" (known: ${known}).`,
        );
      }
      // Widen the open generics to the engine's `CompiledGraph<string>` / `CompiledGraphFactory`.
      return graph as ResolvedGraph;
    },
    schemas: async (graphId) => ({ [graphId]: { graph_id: graphId } }) as unknown as GraphSchemas,
  };
}

/**
 * Build a `ProtocolDeps` backed by fresh in-process drivers (store, queue, bus, checkpointer) around
 * graphs you already hold in code — no `langgraph.json`, no CLI. Pass a map of compiled graphs (or
 * factories), or a ready {@link GraphResolver}. Hand the result to any adapter's `{ deps }` seam:
 *
 * ```ts
 * import { createInMemoryDeps } from "@skein-js/server-kit";
 * import { createExpressServer } from "@skein-js/express";
 *
 * createExpressServer({ deps: createInMemoryDeps({ myAgent: graph }) }).listen(2024);
 * ```
 *
 * `overrides` replaces any driver or adds `auth`/`logger` — e.g. swap in a Postgres store + Redis
 * queue for a durable, horizontally-scalable deployment. `graphs` is intentionally excluded from
 * `overrides` (the first argument is the single source of graphs), so a stray `graphs` key can't
 * silently void it.
 */
export function createInMemoryDeps(
  graphs: GraphResolver | Record<string, EmbeddableGraph>,
  overrides: Omit<Partial<ProtocolDeps>, "graphs"> = {},
): ProtocolDeps {
  return {
    store: new MemorySkeinStore(),
    graphs: isGraphResolver(graphs) ? graphs : graphMapToResolver(graphs),
    queue: new MemoryRunQueue(),
    bus: new MemoryRunEventBus(),
    checkpointer: new MemorySaver(),
    ...overrides,
  };
}
