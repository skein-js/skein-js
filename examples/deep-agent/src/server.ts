// Serve this example's `langgraph.json` over HTTP with @skein-js/express — the programmatic equivalent
// of `skein dev`. Imported by the end-to-end test; run it directly with `tsx src/server.ts`.

import { fileURLToPath, pathToFileURL } from "node:url";

import { createExpressServer, type SkeinExpressServer } from "@skein-js/express";

const configPath = fileURLToPath(new URL("../langgraph.json", import.meta.url));

export interface StartedExample {
  server: SkeinExpressServer;
  /** e.g. `http://127.0.0.1:2024` — point a LangGraph SDK `Client` here. */
  url: string;
  close: () => Promise<void>;
}

/** Boot the server from the example's `langgraph.json` on `port`. */
export async function startServer(port = 2024, host = "127.0.0.1"): Promise<StartedExample> {
  const server = await createExpressServer({ config: configPath });
  const httpServer = await server.listen(port, host);
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return { server, url: `http://${host}:${address.port}`, close: () => server.close() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env["PORT"]) || 2024;
  void startServer(port).then(({ url }) => {
    console.log(`skein-js listening on ${url}`);
  });
}
