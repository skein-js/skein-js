// Turning a `graph_id` into a ready-to-run agent. Shared by the run engine (full protocol runs) and
// the single-graph invoke surface, so both resolve factories and attach the checkpointer the same way.
//
// The long-term store arrives ALREADY BRIDGED, via `ProtocolDeps.storeBridge`. Turning a `StoreRepo`
// into a runtime's own store type is runtime-specific — for LangGraph it means
// `SkeinBaseStore extends BaseStore`, a value import that would put a graph runtime back into this
// package's install. So the binding supplies the bridge and this file only assigns the result.

import type { GraphResolver } from "../deps.js";

import type { AgentGraph } from "./agent-graph.js";

/** What to inject onto the resolved graph before it runs. */
export interface CompiledGraphAttachments {
  /**
   * The `configurable` handed to a graph *factory* export, so a factory that branches on the caller
   * sees the same sanitized principal a node reads. Ignored for an already-compiled graph.
   */
  configurable?: Record<string, unknown>;
  /**
   * Owns graph state, history, and interrupt/resume. Opaque here on purpose — this package never
   * learns which checkpointer type the runtime wanted, it only assigns it. Absent attaches none.
   */
  checkpointer?: unknown;
  /**
   * The already-bridged long-term store, from `ProtocolDeps.storeBridge`. Opaque here on purpose —
   * this package never learns what type the runtime wanted. Absent attaches nothing.
   */
  store?: unknown;
}

/**
 * Load a graph by id, invoking a factory export with {@link CompiledGraphAttachments.configurable},
 * then attach the checkpointer.
 *
 * The attachments go onto a **per-call prototype clone**, never the resolved graph itself. A
 * non-factory export is memoized by the resolver, so every caller shares one `CompiledGraph`
 * instance — mutating it would publish this call's checkpointer to every concurrent call. That is
 * harmless only while every caller attaches the *same* saver; the single-graph invoke surface
 * attaches a throwaway one per request, so a concurrent protocol run could otherwise pick it up and
 * silently write its thread state to a discarded in-memory saver instead of the durable
 * checkpointer. Cloning keeps each call's attachments private. (LangGraph exposes `store` as a
 * per-call option but `checkpointer` only as an instance property, so the clone is what makes a
 * per-call checkpointer possible at all.)
 */
export async function resolveCompiledGraph(
  graphs: GraphResolver,
  graphId: string,
  attachments: CompiledGraphAttachments,
): Promise<AgentGraph> {
  const resolved = await graphs.load(graphId);
  const shared =
    typeof resolved === "function"
      ? await resolved({ configurable: attachments.configurable })
      : resolved;
  // Prototype clone: methods resolve through the chain with `this` bound to the clone, so our own
  // `checkpointer` shadows the shared instance's without ever writing to it.
  const graph = Object.create(shared) as AgentGraph;
  if (attachments.checkpointer !== undefined) {
    (graph as { checkpointer?: unknown }).checkpointer = attachments.checkpointer;
  }
  if (attachments.store !== undefined) (graph as { store?: unknown }).store = attachments.store;
  return graph;
}
