// A running skein Next.js adapter backed by a zero-setup echo graph and in-memory drivers, exercised
// over real HTTP. Next.js isn't booted here; instead a tiny `node:http` server bridges requests to
// the adapter's handlers — the App Router handlers (Web `Request` → Web `Response`) or the Pages
// Router handler (Node req/res) — so the same conformance suite runs against both routers. `basePath`
// is `""` so the shared test can hit `/threads` directly (no `/api` mount).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

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

import { createSkeinPagesHandler } from "../create-pages-handler.js";
import { createSkeinRouteHandlers, type SkeinRouteHandlers } from "../create-route-handlers.js";

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

export function createEchoDeps(auth?: AuthEngine): ProtocolDeps {
  const resolver: GraphResolver = {
    ids: ["echo"],
    load: (() => {
      const graph = buildEchoGraph();
      return async () => graph;
    })(),
    schemas: async (graphId) => ({ [graphId]: { graph_id: graphId } }) as unknown as GraphSchemas,
  };
  return {
    store: new MemorySkeinStore(),
    graphs: resolver,
    queue: new MemoryRunQueue(),
    bus: new MemoryRunEventBus(),
    checkpointer: new MemorySaver(),
    auth,
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Build a Web `Request` from a Node request + already-read body buffer. */
function toWebRequest(req: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? "GET";
  const hasBody = body.length > 0 && method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    ...(hasBody ? { body, duplex: "half" } : {}),
  };
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, init);
}

/** Pump a Web `Response` back onto the Node response, cancelling the source when the client hangs up. */
async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on("close", () => void reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    // Client closed mid-stream; nothing more to write.
  }
  if (!res.writableEnded) res.end();
}

export interface RunningServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Boot a bridge server for the given router on an ephemeral loopback port. */
export async function startEchoServer(options: {
  router: "app" | "pages";
  cors?: boolean | CorsOptions;
  auth?: AuthEngine;
}): Promise<RunningServer> {
  const deps = createEchoDeps(options.auth);
  const appHandlers: SkeinRouteHandlers = createSkeinRouteHandlers({
    deps,
    cors: options.cors,
    basePath: "",
  });
  const pagesHandler = createSkeinPagesHandler({ deps, cors: options.cors, basePath: "" });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      if (options.router === "pages") {
        const pagesReq = req as IncomingMessage & { body?: unknown };
        pagesReq.body = body.length ? JSON.parse(body.toString("utf8")) : undefined;
        await pagesHandler(pagesReq, res);
      } else {
        const method = (req.method ?? "GET").toUpperCase() as keyof SkeinRouteHandlers;
        const handler = appHandlers[method] ?? appHandlers.GET;
        const response = await handler(toWebRequest(req, body));
        await writeWebResponse(response, res);
      }
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else if (!res.writableEnded) res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
