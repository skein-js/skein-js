import { createServer } from "node:http";

import { interrupt, MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { filterSkeinRoutes, skeinRoutes } from "@skein-js/agent-protocol";
import {
  embedInMemoryGraphs,
  readNativeNodeRequest,
  sendNativeResponse,
} from "@skein-js/server-kit";
import { runInteropHttpConformance } from "@skein-js/test-support";

import { createSkeinFetchServer } from "./skein-fetch-server.js";

runInteropHttpConformance("Fetch", async (options) => {
  const graph = new StateGraph(MessagesAnnotation)
    .addNode("echo", (state, config) => ({
      messages: [
        {
          role: "assistant" as const,
          content:
            state.messages.at(-1)?.content === "headers"
              ? JSON.stringify({
                  tenant: config.configurable?.["x-tenant"],
                  thread: config.configurable?.["thread_id"],
                })
              : state.messages.at(-1)?.content === "mcp-question"
                ? `approved: ${String(interrupt("approve?"))}`
                : "echo",
        },
      ],
    }))
    .addEdge("__start__", "echo")
    .addEdge("echo", "__end__")
    .compile();
  const runtime = await createSkeinFetchServer({
    routes: filterSkeinRoutes(skeinRoutes, options?.disable ?? {}),
    deps: embedInMemoryGraphs(
      { echo: graph },
      {
        auth: options?.auth,
        ...(options?.configuredHeaders
          ? { configurableHeaders: { includes: ["x-*", "thread_id"] } }
          : {}),
      },
    ),
  });
  const server = createServer((request, response) => {
    void (async () => {
      const native = await readNativeNodeRequest(
        request,
        `http://${request.headers.host}${request.url}`,
      );
      await sendNativeResponse(await runtime.fetch(native), response);
    })().catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: async () => {
      await runtime.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
});
