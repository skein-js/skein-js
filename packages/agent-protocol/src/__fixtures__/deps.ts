// Shared test scaffolding: a `ProtocolDeps` wired to the in-memory drivers, a `GraphResolver` over
// the fixture graphs, and a couple of async-iterable helpers. Keeps every test one line from a
// working engine.

import { MemorySaver } from "@langchain/langgraph";
import { MemoryRunEventBus, MemoryRunQueue, MemorySkeinStore } from "@skein-js/storage-memory";

import type { GraphResolver, GraphSchemas, ProtocolDeps, ResolvedGraph } from "../deps.js";

import { fixtureGraphs } from "./graphs.js";

/** A `GraphResolver` backed by the fixture graphs. */
export function createFixtureResolver(): GraphResolver {
  return {
    ids: Object.keys(fixtureGraphs),
    load: async (graphId): Promise<ResolvedGraph> => {
      const graph = fixtureGraphs[graphId];
      if (!graph) throw new Error(`unknown fixture graph "${graphId}"`);
      return graph;
    },
    schemas: async (graphId): Promise<GraphSchemas> =>
      ({ [graphId]: { graph_id: graphId } }) as unknown as GraphSchemas,
  };
}

/** Build in-memory deps, with optional overrides (e.g. a `runTimeoutMs` or a custom queue). */
export function createFixtureDeps(overrides: Partial<ProtocolDeps> = {}): ProtocolDeps {
  return {
    store: new MemorySkeinStore(),
    graphs: createFixtureResolver(),
    queue: new MemoryRunQueue(),
    bus: new MemoryRunEventBus(),
    checkpointer: new MemorySaver(),
    ...overrides,
  };
}

/** Drain an async iterable into an array. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
