// A running skein Fastify server backed by a zero-setup echo graph and in-memory drivers, so a test
// is one call away from exercising the real adapter over HTTP. Uses the injected-`deps` path (no
// langgraph.json on disk needed) — the same fixture shape as the Express adapter's.

import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import {
  type CompiledGraph,
  MemorySaver,
  MessagesAnnotation,
  StateGraph,
} from "@langchain/langgraph";
import type { GraphResolver, GraphSchemas, ProtocolDeps } from "@skein-js/agent-protocol";
import type { AuthEngine } from "@skein-js/core";
import type { CorsOptions } from "@skein-js/server-kit";
import { MemoryRunEventBus, MemoryRunQueue, MemorySkeinStore } from "@skein-js/storage-memory";

import { createFastifyServer, type SkeinFastifyServer } from "../create-fastify-server.js";

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

/** A `GraphResolver` exposing a single `echo` graph. */
export function createEchoResolver(): GraphResolver {
  const graph = buildEchoGraph();
  return {
    ids: ["echo"],
    load: async () => graph,
    schemas: async (graphId) => ({ [graphId]: { graph_id: graphId } }) as unknown as GraphSchemas,
  };
}

/** In-memory `ProtocolDeps` around the echo graph, optionally with an auth engine. */
export function createEchoDeps(auth?: AuthEngine): ProtocolDeps {
  return {
    store: new MemorySkeinStore(),
    graphs: createEchoResolver(),
    queue: new MemoryRunQueue(),
    bus: new MemoryRunEventBus(),
    checkpointer: new MemorySaver(),
    auth,
  };
}

export interface RunningServer {
  /** e.g. `http://127.0.0.1:54321` — point a client (or `fetch`) here. */
  baseUrl: string;
  server: SkeinFastifyServer;
  /** Stop the worker and close the HTTP server. */
  close: () => Promise<void>;
}

/** Boot the echo server on an ephemeral loopback port. `cors` is off unless explicitly enabled. */
export async function startEchoServer(
  options: { cors?: boolean | CorsOptions; auth?: AuthEngine } = {},
): Promise<RunningServer> {
  const server = await createFastifyServer({
    deps: createEchoDeps(options.auth),
    cors: options.cors,
  });
  const httpServer = await server.listen(0, "127.0.0.1");
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, server, close: () => server.close() };
}
