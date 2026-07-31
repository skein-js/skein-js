// The headline conformance check: drive the running skein-js server with the real
// `@langchain/langgraph-sdk` client. If the official client's `threads.create` / `runs.wait` /
// `runs.stream` are happy against our Express adapter, the wire format is right.

import { Client } from "@langchain/langgraph-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServer, type StartedExample } from "./server.js";

describe("express-basic over @langchain/langgraph-sdk", () => {
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

  // The four routes the official SDK calls that skein previously 404'd. Driven through the real
  // client rather than the handler table, so a path or verb mismatch in any adapter shows up here.
  it("blocks on runs.join and returns the settled run's final state", async () => {
    const thread = await client.threads.create();
    const run = await client.runs.create(thread.thread_id, "echo", {
      input: { messages: [{ role: "user", content: "joined" }] },
    });

    const values = await client.runs.join(thread.thread_id, run.run_id);

    expect(JSON.stringify(values)).toContain("echo: joined");
  });

  it("reads state at a checkpoint given as an object, not just as an id", async () => {
    // `threads.getState` picks its route from the argument's *type*: an object checkpoint is POSTed
    // to `/state/checkpoint`, which is the route that did not exist.
    const thread = await client.threads.create();
    await client.runs.wait(thread.thread_id, "echo", {
      input: { messages: [{ role: "user", content: "checkpointed" }] },
    });

    const tip = await client.threads.getState(thread.thread_id);
    const atCheckpoint = await client.threads.getState(thread.thread_id, tip.checkpoint);

    expect(JSON.stringify(atCheckpoint.values)).toContain("echo: checkpointed");
  });

  it("serves thread history, which the SDK pages with a body", async () => {
    const thread = await client.threads.create();
    await client.runs.wait(thread.thread_id, "echo", {
      input: { messages: [{ role: "user", content: "historic" }] },
    });

    const history = await client.threads.getHistory(thread.thread_id, { limit: 5 });

    expect(history.length).toBeGreaterThan(0);
    expect(history.length).toBeLessThanOrEqual(5);
  });
});
