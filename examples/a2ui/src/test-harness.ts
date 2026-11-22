import { fileURLToPath } from "node:url";

import { Client } from "@langchain/langgraph-sdk";
import { createExpressServer } from "@skein-js/express";
import { embedSqliteGraphs } from "@skein-js/local";
import { loadInMemoryRuntime } from "@skein-js/server-kit";
import type { MemoryRunEventBus } from "@skein-js/storage-memory";

import { auth } from "./auth.js";
import type { GenerateText } from "./generation.js";
import { prepareUiRun } from "./ui-client.js";
import { graph as uiGraph } from "./ui-graph.js";

/** Actual public config/auth/HTTP; only text generation and storage lifetime are test-controlled. */
export async function startHarness(
  generateText: GenerateText,
  options: { sqlitePath?: string; bus?: MemoryRunEventBus } = {},
) {
  const graph = uiGraph.withConfig({ context: { generateText } });

  const loaded = await loadInMemoryRuntime(
    fileURLToPath(new URL("../langgraph.json", import.meta.url)),
    async (filename) => {
      if (filename.endsWith("/auth.ts")) return { auth };
      if (filename.endsWith("/live-graph.ts")) return { graph };
      throw new Error("Unexpected example module: " + filename);
    },
  );

  const sqlite = options.sqlitePath
    ? await embedSqliteGraphs(
        { "ui-playground": graph },
        {
          sqlitePath: options.sqlitePath,
          overrides: { auth: loaded.deps.auth },
        },
      )
    : null;

  const deps = sqlite?.deps ?? loaded.deps;
  if (options.bus) deps.bus = options.bus;
  const server = await createExpressServer({ deps });
  const listener = await server.listen(0, "127.0.0.1");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Expected a bound HTTP address");
  const url = "http://127.0.0.1:" + address.port;
  return {
    url,
    listener,
    deps,
    clientFor: (user = "demo-user") =>
      new Client<Record<string, unknown>>({
        apiUrl: url,
        apiKey: null,
        defaultHeaders: { "x-user": user },
        onRequest: prepareUiRun,
      }),
    async close() {
      try {
        await server.close();
      } finally {
        await sqlite?.dispose();
      }
    },
  };
}
