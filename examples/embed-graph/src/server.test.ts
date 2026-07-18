// Conformance check for the in-code path: drive the running server with the real
// `@langchain/langgraph-sdk` client. If the official client's `threads.create` / `runs.wait` /
// `runs.stream` are happy against a server built from `createInMemoryDeps({ echo })` — with no
// `langgraph.json` anywhere — the in-code embedding path is wire-correct.

import { Client } from "@langchain/langgraph-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServer, type StartedExample } from "./server.js";

describe("embed-graph (in-code deps) over @langchain/langgraph-sdk", () => {
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

  it("streams the echoed reply", async () => {
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
