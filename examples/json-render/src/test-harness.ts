import { fileURLToPath } from "node:url";

import { Client } from "@langchain/langgraph-sdk";
import { createExpressServer } from "@skein-js/express";

import { auth } from "./auth.js";
import { fixtureSpecStream, generateFixtureText } from "./generation-fixture.js";
import type { GenerateText } from "./generation.js";
import { addRunIdempotency } from "./ui-client.js";
import { graph } from "./ui-graph.js";

/** Real config/auth/HTTP, with only generation injected so tests never call a provider. */
export async function startHarness(generateText: GenerateText = generateFixtureText) {
  const fixtureGraph = graph.withConfig({ context: { generateText } });

  const server = await createExpressServer({
    config: fileURLToPath(new URL("../langgraph.json", import.meta.url)),
    importModule: async (filename) => {
      if (filename.endsWith("/auth.ts")) return { auth };
      if (filename.endsWith("/ui-graph.ts")) return { graph: fixtureGraph };
      throw new Error("Unexpected example module: " + filename);
    },
  });

  const listener = await server.listen(0, "127.0.0.1");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Expected a bound HTTP address");
  const url = "http://127.0.0.1:" + address.port;
  return {
    url,
    listener,
    clientFor: (user = "demo-user") =>
      new Client<Record<string, unknown>>({
        apiUrl: url,
        apiKey: null,
        defaultHeaders: { "x-user": user },
        onRequest: addRunIdempotency,
      }),
    close: () => server.close(),
  };
}

export const generateImmediateText: GenerateText = async function* (request) {
  const text = fixtureSpecStream(request);
  for (let offset = 0; offset < text.length; offset += 37) yield text.slice(offset, offset + 37);
};
