// Shared by the end-to-end suites: boot the example's own `langgraph.json` on a real port and talk to
// it with the official `@langchain/langgraph-sdk` client, signed in as whichever user a test needs.

import { createServer } from "node:net";

import { Client } from "@langchain/langgraph-sdk";
import type { AsyncTask } from "deepagents";

import type { StartedExample } from "./server.js";

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

/** A port nothing is listening on — the deep dive has to know the server's URL before it boots. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

/** Boot the server offline (the scripted model), signed-in clients one call away. */
export async function startHarness(): Promise<Harness> {
  const port = await freePort();
  process.env["SKEIN_URL"] = `http://127.0.0.1:${port}`;
  delete process.env["DEEP_AGENT_MODEL"];
  // Imported after the env is set: the graph modules read SKEIN_URL when they load.
  const { startServer } = await import("./server.js");
  const started: StartedExample = await startServer(port);
  return {
    url: started.url,
    clientFor: (user) => new Client({ apiUrl: started.url, defaultHeaders: { "x-user": user } }),
    close: () => started.close(),
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
