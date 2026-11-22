// Shared by the end-to-end suites: boot the example's own `langgraph.json` on a real port and talk to
// it with the official `@langchain/langgraph-sdk` client, signed in as whichever user a test needs.

import { fileURLToPath } from "node:url";

import { Client } from "@langchain/langgraph-sdk";
import { createExpressServer } from "@skein-js/express";
import type { AsyncTask } from "deepagents";
import { vi } from "vitest";

vi.mock("./model.js", async () => {
  const { ScriptedChatModel } = await import("./test-model.js");
  return {
    selectModel: (role: "assistant" | "researcher") => new ScriptedChatModel({ role }),
  };
});

export const ASSISTANT = "briefing-assistant";

type Message = { type?: string; content?: unknown };
export type AssistantState = {
  messages?: Message[];
  todos?: { content: string; status: string }[];
  files?: Record<string, unknown>;
  asyncTasks?: Record<string, AsyncTask>;
};

export interface Harness {
  url: string;
  clientFor(user: string): Client;
  close(): Promise<void>;
}

/** Use the example's real config and let Vitest load the graph with the test model. */
export async function startHarness(): Promise<Harness> {
  const server = await createExpressServer({
    config: fileURLToPath(new URL("../langgraph.json", import.meta.url)),
    importModule: (file) => import(/* @vite-ignore */ file),
  });

  const listener = await server.listen(0, "127.0.0.1").catch(async (error: unknown) => {
    await server.close();
    throw error;
  });

  const address = listener.address();

  if (!address || typeof address === "string") {
    await server.close();
    throw new Error("Expected a bound HTTP address");
  }

  const url = `http://127.0.0.1:${address.port}`;
  const previousUrl = process.env["SKEIN_URL"];
  process.env["SKEIN_URL"] = url;

  return {
    url,
    clientFor: (user) => new Client({ apiUrl: url, defaultHeaders: { "x-user": user } }),
    async close() {
      if (previousUrl === undefined) delete process.env["SKEIN_URL"];
      else process.env["SKEIN_URL"] = previousUrl;
      await server.close();
    },
  };
}

/** Send one chat message and wait for the assistant's settled state. */
export async function say(
  client: Client,
  threadId: string,
  content: string,
): Promise<AssistantState> {
  return (await client.runs.wait(threadId, ASSISTANT, {
    input: { messages: [{ role: "user", content }] },
  })) as AssistantState;
}

/** The assistant's last reply, as text. */
export function replyOf(state: AssistantState): string {
  const content = state.messages?.at(-1)?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}
