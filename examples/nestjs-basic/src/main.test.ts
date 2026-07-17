// The headline conformance check: drive the running skein-js NestJS server with the real
// `@langchain/langgraph-sdk` client. If the official client is happy against our NestJS adapter, the
// wire format is right.

import "reflect-metadata";

import { Client } from "@langchain/langgraph-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServer, type StartedExample } from "./main.js";

describe("nestjs-basic over @langchain/langgraph-sdk", () => {
  let started: StartedExample;
  let client: Client;

  beforeAll(async () => {
    started = await startServer(0);
    client = new Client({ apiUrl: started.url });
  });

  afterAll(async () => {
    await started.close();
  });

  it("creates a thread and waits for the echoed reply", async () => {
    const thread = await client.threads.create();
    expect(typeof thread.thread_id).toBe("string");

    const values = await client.runs.wait(thread.thread_id, "echo", {
      input: { messages: [{ role: "user", content: "hello" }] },
    });

    expect(JSON.stringify(values)).toContain("echo: hello");
  });

  it("streams the echoed reply token stream", async () => {
    const thread = await client.threads.create();
    const chunks: string[] = [];

    for await (const chunk of client.runs.stream(thread.thread_id, "echo", {
      input: { messages: [{ role: "user", content: "streamed" }] },
      streamMode: "values",
    })) {
      chunks.push(JSON.stringify(chunk));
    }

    expect(chunks.join("\n")).toContain("echo: streamed");
  });
});
