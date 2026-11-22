// A short session with the briefing assistant, against a running server (`pnpm dev`):
//
//   pnpm demo
//
// It is the same @langchain/langgraph-sdk code a web or chat app would write: tell the assistant how you
// like briefings, ask for one while showing the research subagent's progress live, then approve a
// simulated email if the assistant requests approval.

import { coerceMessageLikeToMessage } from "@langchain/core/messages";
import { Client, type Message } from "@langchain/langgraph-sdk";

const client = new Client({
  apiUrl: process.env["SKEIN_URL"] ?? "http://127.0.0.1:2024",
  defaultHeaders: { "x-user": process.env["DEMO_USER"] ?? "demo-user" },
});

const assistant = "briefing-assistant";

function lastReply(values: unknown): string {
  const message = (values as { messages?: Message[] }).messages?.at(-1);
  return message?.type === "ai" ? coerceMessageLikeToMessage(message).text : "";
}

async function ask(threadId: string, content: string): Promise<void> {
  console.log(`\nyou › ${content}`);
  const reply = lastReply(
    await client.runs.wait(threadId, assistant, {
      input: { messages: [{ role: "user", content }] },
    }),
  );
  console.log(`assistant › ${reply}`);
}

// 1. A preference saved once applies to every future conversation.
const setup = await client.threads.create();
await ask(setup.thread_id, "Remember that I prefer short briefings in bullet points.");

// 2. A briefing in a new conversation. `streamSubgraphs` labels the research subagent's frames
//    (`updates|tools:<id>`), so a UI can show "researching…" apart from the chat itself.
type ModelUpdate = { messages?: { tool_calls?: { name: string }[] }[] };
const thread = await client.threads.create();
console.log("\nyou › Brief me on heat pumps.");

for await (const chunk of client.runs.stream(thread.thread_id, assistant, {
  input: { messages: [{ role: "user", content: "Brief me on heat pumps." }] },
  streamMode: ["updates"],
  streamSubgraphs: true,
})) {
  // Each model step says what it decided to do next; the event name says which agent took it.
  const decision = (chunk.data as { model_request?: ModelUpdate } | undefined)?.model_request;
  if (!decision) continue;
  const who = chunk.event.includes("|") ? "researcher" : "assistant ";
  const calls = decision.messages?.at(-1)?.tool_calls?.map((call) => call.name) ?? [];
  console.log(`   ${who} · ${calls.length > 0 ? `→ ${calls.join(", ")}` : "writes its reply"}`);
}

const state = await client.threads.getState(thread.thread_id);
console.log(`assistant › ${lastReply(state.values)}`);
const files = (state.values as { files?: Record<string, { content?: unknown }> }).files ?? {};

for (const [path, file] of Object.entries(files)) {
  const content = file.content;
  console.log(`\n── ${path} ──\n${Array.isArray(content) ? content.join("\n") : String(content)}`);
}

// 3. Sending a simulated email requires approval. A UI would offer approve, edit, or reject.
console.log("\nyou › Email the briefing to facilities@example.com");
const reply = await client.runs.wait(thread.thread_id, assistant, {
  input: { messages: [{ role: "user", content: "Email the briefing to facilities@example.com" }] },
});

const pending = await client.threads.getState(thread.thread_id);
type ApprovalRequest = { actionRequests?: { name: string; args: { to?: string } }[] };
const actions = pending.tasks
  .flatMap((task) => task.interrupts)
  .flatMap((request) => (request.value as ApprovalRequest).actionRequests ?? []);

if (actions.length > 0 && actions.every((action) => action.name === "send_briefing")) {
  for (const action of actions) {
    console.log(`   (paused: ${action.name} to ${action.args.to} needs approval — approving)`);
  }

  const resumed = await client.runs.wait(thread.thread_id, assistant, {
    command: { resume: { decisions: actions.map(() => ({ type: "approve" })) } },
  });
  console.log(`assistant › ${lastReply(resumed)}`);
} else {
  console.log(`assistant › ${lastReply(reply)}`);
}
