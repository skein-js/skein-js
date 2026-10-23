import { createServer } from "node:http";

import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import {
  embedInMemoryGraphs,
  readNativeNodeRequest,
  sendNativeResponse,
} from "@skein-js/server-kit";
import { runInteropHttpConformance } from "@skein-js/test-support";

import { createSkeinFetchServer } from "./skein-fetch-server.js";

runInteropHttpConformance("Fetch", async (options) => {
  const graph = new StateGraph(MessagesAnnotation)
    .addNode("echo", () => ({ messages: [{ role: "assistant" as const, content: "echo" }] }))
    .addEdge("__start__", "echo")
    .addEdge("echo", "__end__")
    .compile();
  const runtime = await createSkeinFetchServer({
    deps: embedInMemoryGraphs({ echo: graph }, { auth: options?.auth }),
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
