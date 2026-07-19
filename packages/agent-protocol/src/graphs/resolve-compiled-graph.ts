// Turning a `graph_id` into a ready-to-run compiled graph. Shared by the run engine (full protocol
// runs) and the single-graph invoke surface, so both resolve factories and inject the checkpointer +
// long-term store exactly the same way. Both mirror how `@langchain/langgraph-api` attaches its saver
// and store onto the compiled graph, so a graph written for LangGraph Platform runs unchanged.

import type { BaseCheckpointSaver, CompiledGraph } from "@langchain/langgraph";
import type { StoreRepo } from "@skein-js/core";

import type { GraphResolver } from "../deps.js";
import { SkeinBaseStore } from "../store/skein-base-store.js";

/** What to inject onto the resolved graph before it runs. */
export interface CompiledGraphAttachments {
  /**
   * The `configurable` handed to a graph *factory* export, so a factory that branches on the caller
   * sees the same sanitized principal a node reads. Ignored for an already-compiled graph.
   */
  configurable?: Record<string, unknown>;
  /** Owns graph state, history, and interrupt/resume. */
  checkpointer: BaseCheckpointSaver;
  /** Bridged in as a LangGraph `BaseStore` so nodes reach cross-thread memory via `getStore()`. */
  store: StoreRepo;
}

/**
 * Load a graph by id, invoking a factory export with {@link CompiledGraphAttachments.configurable},
 * then attach the checkpointer and the long-term store.
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
): Promise<CompiledGraph<string>> {
  const resolved = await graphs.load(graphId);
  const shared =
    typeof resolved === "function"
      ? await resolved({ configurable: attachments.configurable })
      : resolved;
  // Prototype clone: methods resolve through the chain with `this` bound to the clone, so our own
  // `checkpointer`/`store` shadow the shared instance's without ever writing to it.
  const graph = Object.create(shared) as CompiledGraph<string>;
  (graph as { checkpointer?: unknown }).checkpointer = attachments.checkpointer;
  (graph as { store?: unknown }).store = new SkeinBaseStore(attachments.store);
  return graph;
}
