// The model-backed conformance check: drive the running skein-js server with the real
// `@langchain/langgraph-sdk` client against a live Gemini model. If the official client's
// `runs.wait` and `runs.stream` both exercise the wire format end to end. Skipped unless
// GOOGLE_API_KEY is set, so CI without a key stays green.

import { Client } from "@langchain/langgraph-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServer, type StartedExample } from "./server.js";

const hasKey = Boolean(process.env["GOOGLE_API_KEY"]);

describe.skipIf(!hasKey)(
  "chat-app research agent over @langchain/langgraph-sdk (live Gemini)",
  () => {
    let started: StartedExample;
    let client: Client;

    beforeAll(async () => {
      started = await startServer(0);
      client = new Client({ apiUrl: started.url });
    });

    afterAll(async () => {
      await started.close();
    });

    it("waits for a research reply on a fresh thread", async () => {
      const thread = await client.threads.create();

      const values = (await client.runs.wait(thread.thread_id, "research", {
        input: { messages: [{ role: "user", content: "In one sentence, what is TypeScript?" }] },
      })) as { messages?: Array<{ type?: string; content?: unknown }> };

      const reply = (values.messages ?? []).at(-1);
      expect(reply?.type).toBe("ai");
      expect(JSON.stringify(reply?.content ?? "").length).toBeGreaterThan(0);
    }, 60_000);

    it("streams the reply without an error frame", async () => {
      const thread = await client.threads.create();
      const chunks: string[] = [];

      for await (const chunk of client.runs.stream(thread.thread_id, "research", {
        input: { messages: [{ role: "user", content: "Name three primary colors." }] },
        streamMode: "messages",
      })) {
        chunks.push(JSON.stringify(chunk));
      }

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.join("\n")).not.toContain('"event":"error"');
    }, 60_000);
  },
);
