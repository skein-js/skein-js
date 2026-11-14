import { fileURLToPath } from "node:url";

import { MessageProcessor, basicCatalog } from "@a2ui/web_core/v1_0";
import { Client } from "@langchain/langgraph-sdk";
import { createExpressServer } from "@skein-js/express";
import { embedSqliteGraphs } from "@skein-js/local";
import { loadInMemoryRuntime } from "@skein-js/server-kit";
import type { MemoryRunEventBus } from "@skein-js/storage-memory";

import { auth } from "./auth.js";
import { demoResponse, generateDemoText, type GenerateText } from "./generation.js";
import { prepareTripRun } from "./trip-client.js";
import type { RendererMetadata } from "./trip-contract.js";
import { createTripGraph } from "./trip-graph.js";

export function rendererMetadata(): RendererMetadata {
  const processor = new MessageProcessor([basicCatalog]);
  try {
    return {
      a2uiRendererCapabilities: processor.getRendererCapabilities({
        versions: ["1.0"],
        includeInlineCatalogs: false,
      }),
    } as RendererMetadata;
  } finally {
    processor.dispose();
  }
}

/** Actual public config/auth/HTTP; only text generation and storage lifetime are test-controlled. */
export async function startHarness(
  generateText: GenerateText = generateDemoText,
  options: { sqlitePath?: string; bus?: MemoryRunEventBus } = {},
) {
  const graph = createTripGraph(generateText);
  const loaded = await loadInMemoryRuntime(
    fileURLToPath(new URL("../langgraph.json", import.meta.url)),
    async (filename) => {
      if (filename.endsWith("/auth.ts")) return { auth };
      if (filename.endsWith("/trip-graph.ts")) return { graph };
      throw new Error("Unexpected example module: " + filename);
    },
  );
  const sqlite = options.sqlitePath
    ? await embedSqliteGraphs(
        { "trip-planner": graph },
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
        onRequest: prepareTripRun,
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

export const generateImmediateText: GenerateText = async function* (request) {
  const text = demoResponse(request.prompt, request.generationId);
  for (let offset = 0; offset < text.length; offset += 37) yield text.slice(offset, offset + 37);
};
