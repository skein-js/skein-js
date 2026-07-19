// Smoke test for the simplified serving surface: both graphs answer on their own endpoint, the body
// is the input and the response is the final state, and the app's own route still serves.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServer, type StartedExample } from "./server.js";

describe("invoke-endpoint example", () => {
  let started: StartedExample;

  beforeAll(async () => {
    started = await startServer(0);
  });

  afterAll(async () => {
    await started.close();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${started.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("triages an urgent billing ticket as P1", async () => {
    const response = await post("/invoke/triage", { text: "Refund charge failed — urgent!" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ category: "billing", priority: "P1" });
  });

  it("triages a calm question as general/P3", async () => {
    const response = await post("/invoke/triage", { text: "How do I export my data?" });

    expect(await response.json()).toMatchObject({ category: "general", priority: "P3" });
  });

  it("serves the second graph on its own endpoint", async () => {
    const response = await post("/invoke/extract", {
      text: "Mail ada@example.com or see https://example.com/docs",
    });

    expect(await response.json()).toMatchObject({
      emails: ["ada@example.com"],
      urls: ["https://example.com/docs"],
    });
  });

  it("404s an unknown graph and leaves the app's own route alone", async () => {
    expect((await post("/invoke/nope", { text: "x" })).status).toBe(404);
    expect(await (await fetch(`${started.url}/health`)).json()).toEqual({ ok: true });
  });
});
