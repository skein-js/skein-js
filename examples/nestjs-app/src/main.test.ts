// Proves the two halves coexist: the app's own REST controller AND the Agent Protocol (served at the
// root by SkeinModule's middleware), the latter driven by the real `@langchain/langgraph-sdk` client.

import "reflect-metadata";

import { Client } from "@langchain/langgraph-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServer, type StartedExample } from "./main.js";

describe("nestjs-app (embedded) — own controller + Agent Protocol", () => {
  let started: StartedExample;
  let client: Client;

  beforeAll(async () => {
    started = await startServer(0);
    client = new Client({ apiUrl: started.url });
  });

  afterAll(async () => {
    await started.close();
  });

  it("still serves the app's own REST controller", async () => {
    const todos = (await (await fetch(`${started.url}/api/todos`)).json()) as Array<{
      title: string;
    }>;
    expect(todos.some((todo) => todo.title === "Try skein-js")).toBe(true);
  });

  it("serves the Agent Protocol at the root (echo graph via the SDK)", async () => {
    const thread = await client.threads.create();
    const values = await client.runs.wait(thread.thread_id, "echo", {
      input: { messages: [{ role: "user", content: "hello" }] },
    });
    expect(JSON.stringify(values)).toContain("echo: hello");
  });
});
