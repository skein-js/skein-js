// Serve this example's `langgraph.json` (the zero-setup `echo` graph + a Gemini `agent` graph) with
// @skein-js/nestjs — a standalone NestJS server whose only job is to serve the graphs. Run it
// directly with `tsx src/main.ts` (PORT overridable), or import `startServer` in a test.

// NestJS's DI reads decorator metadata via reflect-metadata; load it before any Nest code runs.
import "reflect-metadata";

import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createNestServer, type SkeinNestServer } from "@skein-js/nestjs";

const configPath = fileURLToPath(new URL("../langgraph.json", import.meta.url));

export interface StartedExample {
  server: SkeinNestServer;
  /** e.g. `http://127.0.0.1:2024` — point a LangGraph SDK `Client` here. */
  url: string;
  close: () => Promise<void>;
}

/** Boot the server from the example's `langgraph.json`. Pass port `0` for an ephemeral test port. */
export async function startServer(port = 2024, host = "127.0.0.1"): Promise<StartedExample> {
  const server = await createNestServer({ config: configPath });
  await server.listen(port, host);
  const address = server.app.getHttpServer().address() as AddressInfo | null;
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return {
    server,
    url: `http://${host}:${address.port}`,
    close: () => server.close(),
  };
}

// Run directly (`tsx src/main.ts`) — but stay quiet when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env["PORT"]) || 2024;
  void startServer(port).then(({ url }) => {
    console.log(`skein-js (nestjs) listening on ${url}`);
  });
}
