// Proves the two halves coexist: the app's own REST route AND the Agent Protocol (under /agent),
// the latter driven by the real `@langchain/langgraph-sdk` client.

import { Client } from "@langchain/langgraph-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServer, type StartedExample } from "./app.js";

describe("fastify-app (embedded) — own routes + Agent Protocol", () => {
  let started: StartedExample;
  let client: Client;

  beforeAll(async () => {
    started = await startServer(0);
    // The protocol is mounted under /agent, so the SDK points there.
    client = new Client({ apiUrl: `${started.url}/agent` });
  });

  afterAll(async () => {
    await started.close();
  });

  it("still serves the app's own REST routes", async () => {
    const health = await fetch(`${started.url}/health`);
    expect(await health.json()).toEqual({ ok: true });

    const todos = (await (await fetch(`${started.url}/api/todos`)).json()) as Array<{
      title: string;
    }>;
    expect(todos.some((todo) => todo.title === "Try skein-js")).toBe(true);
  });

  it("serves the Agent Protocol under /agent (echo graph via the SDK)", async () => {
    const thread = await client.threads.create();
    const values = await client.runs.wait(thread.thread_id, "echo", {
      input: { messages: [{ role: "user", content: "hello" }] },
    });
    expect(JSON.stringify(values)).toContain("echo: hello");
  });
});
