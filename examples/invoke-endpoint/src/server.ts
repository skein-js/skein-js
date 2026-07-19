// Serve graphs as plain HTTP endpoints — the simplified alternative to the full Agent Protocol, for
// non-chat work. Every graph in the map becomes `POST /invoke/<graph_id>`: the request body IS the
// graph input, the response IS its final state. No threads, assistants, or runs.
//
//   curl -X POST localhost:2024/invoke/triage -H 'content-type: application/json' \
//        -d '{"text":"Payment failed and it is urgent"}'
//
// The app's own `/health` route sits alongside it, untouched — the router claims only `/invoke/*`.

import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";

import { skeinInvokeRouter } from "@skein-js/express";
import { embedInMemoryGraphs } from "@skein-js/server-kit";
import express from "express";

import { graph as extract } from "./extract-graph.js";
import { graph as triage } from "./triage-graph.js";

export interface StartedExample {
  /** e.g. `http://127.0.0.1:2024` */
  url: string;
  close: () => Promise<void>;
}

/** Boot the invoke-only server. Pass port `0` for an ephemeral test port. */
export async function startServer(port = 2024, host = "127.0.0.1"): Promise<StartedExample> {
  const app = express();
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // A graph map → in-memory deps → the invoke router. Keys become endpoints: /invoke/triage,
  // /invoke/extract. Swap `embedInMemoryGraphs` for `embedPostgresGraphs` to go durable.
  const { router } = await skeinInvokeRouter({ deps: embedInMemoryGraphs({ triage, extract }) });
  app.use(router);

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return {
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Run directly (`tsx src/server.ts`) — but stay quiet when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env["PORT"]) || 2024;
  void startServer(port).then(({ url }) => {
    console.log(`skein-js invoke endpoints listening on ${url}`);
    console.log(`  POST ${url}/invoke/triage`);
    console.log(`  POST ${url}/invoke/extract`);
  });
}
