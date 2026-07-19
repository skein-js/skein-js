// The simplified serving surface over real HTTP on Express: raw body in / final state out, opt-in
// SSE, an unregistered graph 404s, and — the property that makes it "embeddable" — the router claims
// only its own path, leaving the host app's routes alone.

import { createServer, type Server } from "node:http";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { createEchoDeps } from "./__fixtures__/echo-server.js";
import { skeinInvokeRouter } from "./skein-invoke-router.js";

const jsonHeaders = { "content-type": "application/json" };

interface Running {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Mount the invoke router on an app that also has its own `/api/todos` route. */
async function startInvokeServer(prefix?: string): Promise<Running> {
  const app = express();
  app.get("/api/todos", (_req, res) => {
    res.json([{ id: 1 }]);
  });
  const { router } = await skeinInvokeRouter({ deps: createEchoDeps(), prefix });
  app.use(router);

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const invoke = (
  baseUrl: string,
  graphId: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(`${baseUrl}/invoke/${graphId}`, {
    method: "POST",
    headers: { ...jsonHeaders, ...headers },
    body: JSON.stringify(body),
  });

describe("skeinInvokeRouter", () => {
  let running: Running | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it("returns the graph's final state for the posted input", async () => {
    running = await startInvokeServer();

    const response = await invoke(running.baseUrl, "echo", {
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.status).toBe(200);
    const state = (await response.json()) as { messages: Array<{ content: string }> };
    expect(state.messages.at(-1)?.content).toBe("echo: hi");
  });

  it("404s an unregistered graph id", async () => {
    running = await startInvokeServer();

    const response = await invoke(running.baseUrl, "nope", { messages: [] });

    expect(response.status).toBe(404);
  });

  it("streams SSE when the caller asks for it", async () => {
    running = await startInvokeServer();

    const response = await invoke(
      running.baseUrl,
      "echo",
      { messages: [{ role: "user", content: "hi" }] },
      { accept: "text/event-stream" },
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("echo: hi");
    expect(text).toContain(`"status":"success"`);
  });

  it("leaves the host app's own routes alone", async () => {
    running = await startInvokeServer();

    const response = await fetch(`${running.baseUrl}/api/todos`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: 1 }]);
  });

  it("honors a custom prefix", async () => {
    running = await startInvokeServer("/graphs");

    const response = await fetch(`${running.baseUrl}/graphs/echo`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(response.status).toBe(200);
  });
});
