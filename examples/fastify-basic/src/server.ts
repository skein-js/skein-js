// Serve this example's `langgraph.json` (the zero-setup `echo` graph + a Gemini `agent` graph) over
// HTTP with @skein-js/fastify — a standalone Fastify server whose only job is to serve the graphs.
// Run it directly with `tsx src/server.ts` (PORT overridable), or import `startServer` in a test to
// drive it with the LangGraph SDK.

import { fileURLToPath, pathToFileURL } from "node:url";

import { createFastifyServer, type SkeinFastifyServer } from "@skein-js/fastify";

// `fileURLToPath` (not `.pathname`) so a path containing spaces/percent chars decodes correctly.
const configPath = fileURLToPath(new URL("../langgraph.json", import.meta.url));

export interface StartedExample {
  server: SkeinFastifyServer;
  /** e.g. `http://127.0.0.1:2024` — point a LangGraph SDK `Client` here. */
  url: string;
  close: () => Promise<void>;
}

/** Boot the server from the example's `langgraph.json`. Pass port `0` for an ephemeral test port. */
export async function startServer(port = 2024, host = "127.0.0.1"): Promise<StartedExample> {
  const server = await createFastifyServer({ config: configPath });
  const httpServer = await server.listen(port, host);
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return { server, url: `http://${host}:${address.port}`, close: () => server.close() };
}

// Run directly (`tsx src/server.ts`) — but stay quiet when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env["PORT"]) || 2024;
  void startServer(port).then(({ url }) => {
    console.log(`skein-js (fastify) listening on ${url}`);
  });
}
