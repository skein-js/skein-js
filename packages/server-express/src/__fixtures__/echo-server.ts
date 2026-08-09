// A running skein Express server backed by a zero-setup echo graph and in-memory drivers, so a test
// is one call away from exercising the real adapter over HTTP. Uses the injected-`deps` path (no
// langgraph.json on disk needed).

import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import {
  type CompiledGraph,
  interrupt,
  MemorySaver,
  MessagesAnnotation,
  StateGraph,
} from "@langchain/langgraph";
import { cloneLangGraphCheckpoint, langGraphResolver, SkeinBaseStore } from "@skein-js/langgraph";
import {
  filterSkeinRoutes,
  skeinRoutes,
  type DisabledRouteGroups,
  type GraphResolver,
  type GraphSchemas,
  type ProtocolDeps,
} from "@skein-js/agent-protocol";
import type { AuthEngine } from "@skein-js/core";
import { MemoryRunEventBus, MemoryRunQueue, MemorySkeinStore } from "@skein-js/storage-memory";
import type { CorsOptions } from "cors";

import { createExpressServer, type SkeinExpressServer } from "../create-express-server.js";

/** A deterministic graph that echoes the last message back — no API key, no network. */
function buildEchoGraph(): CompiledGraph<string> {
  function echo(state: typeof MessagesAnnotation.State): { messages: BaseMessage[] } {
    const last = state.messages.at(-1);
    const text = typeof last?.content === "string" ? last.content : "";
    return { messages: [new AIMessage(`echo: ${text}`)] };
  }
  return new StateGraph(MessagesAnnotation)
    .addNode("echo", echo)
    .addEdge("__start__", "echo")
    .addEdge("echo", "__end__")
    .compile() as unknown as CompiledGraph<string>;
}

/**
 * A graph that pauses for a human, then records what the resume carried.
 *
 * Exists so an adapter test can drive **human-in-the-loop over HTTP**. That path crosses every part of
 * the runtime split: the engine emits a command *envelope* (it no longer constructs a LangGraph
 * `Command` — that would put a graph runtime back in its install), `langGraphResolver` binds the
 * graph, and `langGraphAgent` translates the envelope back. A break anywhere in that chain makes
 * `POST /runs` with a `command` silently no-op — the run succeeds and the state is simply unchanged,
 * which no status code reveals.
 */
function buildInterruptGraph(): CompiledGraph<string> {
  function ask(state: typeof MessagesAnnotation.State): { messages: BaseMessage[] } {
    void state;
    const approval = interrupt("approve?");
    return { messages: [new AIMessage(`approved: ${String(approval)}`)] };
  }
  return new StateGraph(MessagesAnnotation)
    .addNode("ask", ask)
    .addEdge("__start__", "ask")
    .addEdge("ask", "__end__")
    .compile() as unknown as CompiledGraph<string>;
}

/** A `GraphResolver` exposing the `echo` graph plus the interrupting `hitl` graph. */
export function createEchoResolver(): GraphResolver {
  const graphs: Record<string, CompiledGraph<string>> = {
    echo: buildEchoGraph(),
    hitl: buildInterruptGraph(),
  };
  return {
    ids: Object.keys(graphs),
    load: async (graphId) => {
      const graph = graphs[graphId];
      if (!graph) throw new Error(`unknown fixture graph "${graphId}"`);
      return graph;
    },
    schemas: async (graphId) => ({ [graphId]: { graph_id: graphId } }) as unknown as GraphSchemas,
  };
}

/** In-memory `ProtocolDeps` around the echo graph, optionally with an auth engine. */
export function createEchoDeps(auth?: AuthEngine): ProtocolDeps {
  return {
    store: new MemorySkeinStore(),
    graphs: langGraphResolver(createEchoResolver()),
    queue: new MemoryRunQueue(),
    bus: new MemoryRunEventBus(),
    checkpointer: new MemorySaver(),
    // The LangGraph binding: wraps the resolver so the engine's command envelope becomes a `Command`
    // (HITL resume), bridges long-term memory in for `getStore()`, supplies the throwaway saver
    // `/invoke` needs, and clones checkpoints for thread copy/prune/rollback. Hand-assembled deps must
    // wire these — `buildRuntime` and `embedInMemoryGraphs` do it for you.
    storeBridge: (repo) => new SkeinBaseStore(repo),
    ephemeralCheckpointer: () => new MemorySaver(),
    cloneCheckpoint: cloneLangGraphCheckpoint,
    auth,
  };
}

export interface RunningServer {
  /** e.g. `http://127.0.0.1:54321` — point a client (or `fetch`) here. */
  baseUrl: string;
  server: SkeinExpressServer;
  /** Stop the worker and close the HTTP server. */
  close: () => Promise<void>;
}

/** Boot the echo server on an ephemeral loopback port. `cors` is off unless explicitly enabled. */
export async function startEchoServer(
  options: {
    cors?: boolean | CorsOptions;
    auth?: AuthEngine;
    /** Route groups to switch off, as a `langgraph.json` `http.disable_*` block would. */
    disable?: DisabledRouteGroups;
  } = {},
): Promise<RunningServer> {
  const server = await createExpressServer({
    deps: createEchoDeps(options.auth),
    cors: options.cors,
    ...(options.disable ? { routes: filterSkeinRoutes(skeinRoutes, options.disable) } : {}),
  });
  const httpServer = await server.listen(0, "127.0.0.1");
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, server, close: () => server.close() };
}
