// The simplified serving surface over real HTTP on Fastify: raw body in / final state out, opt-in
// SSE, an unregistered graph 404s, and the plugin stays encapsulated under its registration prefix so
// the host app's own routes are untouched.

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { createEchoDeps } from "./__fixtures__/echo-server.js";
import { skeinInvokePlugin } from "./skein-invoke-plugin.js";

const jsonHeaders = { "content-type": "application/json" };

interface Running {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Register the invoke plugin under `/agent`, alongside the app's own `/api/todos` route. */
async function startInvokeServer(): Promise<Running> {
  const app: FastifyInstance = Fastify();
  app.get("/api/todos", async () => [{ id: 1 }]);
  await app.register(skeinInvokePlugin, { prefix: "/agent", deps: createEchoDeps() });
  await app.listen({ port: 0, host: "127.0.0.1" });

  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => app.close() };
}

const invoke = (
  baseUrl: string,
  graphId: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(`${baseUrl}/agent/invoke/${graphId}`, {
    method: "POST",
    headers: { ...jsonHeaders, ...headers },
    body: JSON.stringify(body),
  });

describe("skeinInvokePlugin", () => {
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

    expect((await invoke(running.baseUrl, "nope", { messages: [] })).status).toBe(404);
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
});
