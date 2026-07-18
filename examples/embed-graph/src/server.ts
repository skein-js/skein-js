// Serve a LangGraph.js graph you already have — in code, with NO `langgraph.json` and NO CLI. This is
// the in-code counterpart to `examples/express-basic` (which loads the same kind of graph from a
// `langgraph.json` via `skein dev`). The whole backend is three lines: a graph map →
// `createInMemoryDeps` → an adapter's `{ deps }` seam. Point `useStream` / Agent Chat UI / the
// LangGraph SDK at the URL it prints — they can't tell it apart from the LangGraph Platform.

import { pathToFileURL } from "node:url";

import { createExpressServer, type SkeinExpressServer } from "@skein-js/express";
import { createInMemoryDeps } from "@skein-js/server-kit";

import { graph as echo } from "./echo-graph.js";

export interface StartedExample {
  server: SkeinExpressServer;
  /** e.g. `http://127.0.0.1:2024` — point a LangGraph SDK `Client` here. */
  url: string;
  close: () => Promise<void>;
}

/** Boot the Agent Protocol server around the in-code graph. Pass port `0` for an ephemeral test port. */
export async function startServer(port = 2024, host = "127.0.0.1"): Promise<StartedExample> {
  // A graph map → in-memory ProtocolDeps → an Express server. No config file, no `skein dev`.
  // To embed into an existing Express app instead: `app.use(skeinRouter({ deps }).router)`.
  // For production, swap the in-memory drivers for Postgres + Redis via `createInMemoryDeps({ echo },
  // { store, queue, checkpointer })` (see @skein-js/runtime's `buildRuntime`).
  const server = await createExpressServer({ deps: createInMemoryDeps({ echo }) });
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
    console.log(`skein-js listening on ${url}`);
  });
}
