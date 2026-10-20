// The briefing assistant: ask it to brief you on a topic and it researches, drafts and — with your
// sign-off — emails a one-page briefing, remembering how you like them written.
//
// It is an ordinary `createDeepAgent` export, served from an unchanged `langgraph.json`; there is no
// skein import here. Each Deep Agents feature has a job in the workflow:
//
// - **Planning** — a todo list for each briefing (`write_todos`, from LangChain's todo-list middleware).
// - **Files** — a `CompositeBackend`. Drafts under `/briefings/` are thread state: they belong to the
//   conversation that wrote them. Preferences under `/memories/` live in the store, one namespace per
//   signed-in user, so "I prefer bullet points" applies to every future chat. skein supplies both the
//   checkpointer and the store.
// - **A research subagent** (`researcher`) — run inside the `task` tool. Ask for `stream_subgraphs` and
//   its progress streams under `tools:<id>` event names, so a UI can show "researching…" separately.
// - **Human approval** — `send_briefing` pauses until you approve, edit or reject the email.
// - **A background deep dive** (`deep-researcher`) — the `researcher` graph, run asynchronously over
//   HTTP on this same server, so a long investigation does not hold up the chat. It needs a `url`:
//   skein does not recreate LangGraph Platform's in-process transport.

import type { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { CompositeBackend, createDeepAgent, StateBackend, StoreBackend } from "deepagents";
import { todoListMiddleware } from "langchain";
import { z } from "zod";

import { memoryNamespaceFor } from "./memory-namespace.js";
import { selectModel } from "./model.js";
import { RESEARCHER_PROMPT } from "./researcher-graph.js";

/** Where this server answers — the deep dive calls back into it. */
const SELF_URL = process.env["SKEIN_URL"] ?? "http://127.0.0.1:2024";

/**
 * Emailing is the one irreversible step, so it waits for a person. This demo only pretends to send;
 * a real deployment would call its mail provider here.
 */
const sendBriefing = tool(async ({ to, subject }) => `Emailed "${subject}" to ${to}.`, {
  name: "send_briefing",
  description: "Email a finished briefing to someone.",
  schema: z.object({
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("The briefing text"),
  }),
});

const SYSTEM_PROMPT = `You prepare one-page research briefings.

For each briefing: read /memories/preferences.md for how this reader likes briefings written, plan
with write_todos, delegate the research to the researcher subagent, then save the draft to
/briefings/<topic>.md and tell the reader where it is. When the reader states a lasting preference,
save it to /memories/preferences.md. Only email a briefing when asked, with send_briefing. For a long
investigation, start a deep-researcher async task and report on it when asked.`;

/**
 * Built per caller, so the deep dive — an HTTP call back into this server — runs with the caller's own
 * identity and lands in threads only they can read.
 */
export function graph(config: RunnableConfig) {
  const userId = config.configurable?.["langgraph_auth_user_id"];
  // Introspection can build the graph with no caller. Its empty header is rejected by auth if anyone
  // tries to run it; it must never silently become a demo user or a shared service account.
  const callerHeaders = { "x-user": typeof userId === "string" ? userId : "" };
  return createDeepAgent({
    model: selectModel("assistant"),
    systemPrompt: SYSTEM_PROMPT,
    tools: [sendBriefing],
    // Deep Agents adds `write_todos` only for some model profiles; ask for it so planning works with
    // whichever model `DEEP_AGENT_MODEL` names.
    middleware: [todoListMiddleware()],
    backend: new CompositeBackend(new StateBackend(), {
      "/memories/": new StoreBackend({ namespace: memoryNamespaceFor }),
    }),
    interruptOn: { send_briefing: { allowedDecisions: ["approve", "edit", "reject"] } },
    subagents: [
      {
        name: "researcher",
        description: "Researches a topic and returns concise, organized notes.",
        systemPrompt: RESEARCHER_PROMPT,
        model: selectModel("researcher"),
      },
      {
        name: "deep-researcher",
        description: "Runs a longer research investigation in the background.",
        graphId: "researcher",
        url: SELF_URL,
        headers: callerHeaders,
      },
    ],
  });
}
