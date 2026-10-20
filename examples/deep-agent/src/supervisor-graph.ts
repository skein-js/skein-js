// The supervisor: a Deep Agent with every moving part skein has to host.
//
// - **Planning** — `write_todos` from LangChain's todo-list middleware, kept in thread state.
// - **Files** — a `CompositeBackend`: anything under `/memories/` goes to the store, namespaced per
//   authenticated user, so it outlives the thread; everything else is thread state and lives and dies
//   with the conversation. skein supplies both the checkpointer and the store; nothing here wires one.
// - **A synchronous subagent** (`researcher`) — run inside the `task` tool. Ask for
//   `stream_subgraphs` and its progress streams under `tools:<id>` event names.
// - **Human approval** — `send_report` pauses for an approve / edit / reject decision.
// - **An asynchronous subagent** (`background-researcher`) — the `researcher` graph, driven over HTTP.
//   It must be given a URL: skein does not recreate LangGraph Platform's in-process transport.
//
// No skein import anywhere: this is an ordinary `createDeepAgent` export, served from an unchanged
// `langgraph.json`.

import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { CompositeBackend, createDeepAgent, StateBackend, StoreBackend } from "deepagents";
import { todoListMiddleware } from "langchain";
import { z } from "zod";

import { memoryNamespaceFor } from "./memory-namespace.js";
import { selectModel } from "./model.js";

/** Where this server answers — the async subagent calls back into it. */
const SELF_URL = process.env["SKEIN_URL"] ?? "http://127.0.0.1:2024";

/** A side effect worth a human's sign-off. It only pretends to send. */
const sendReport = tool(async ({ to, body }) => `Sent "${body}" to ${to}.`, {
  name: "send_report",
  description: "Send a written report to a recipient.",
  schema: z.object({
    to: z.string().describe("Who receives the report"),
    body: z.string().describe("The report text"),
  }),
});

/** Build per caller so upstream async tools use that caller's authority on the receiving server. */
export function graph(config: RunnableConfig) {
  const userId = config.configurable?.["langgraph_auth_user_id"];
  // Introspection can construct the graph without a principal. Its empty header is rejected by auth
  // if someone tries to execute it; it must never silently become the demo user or a shared service.
  const delegatedHeaders = { "x-user": typeof userId === "string" ? userId : "" };
  return createDeepAgent({
    model: selectModel(),
    systemPrompt:
      "You coordinate research. Plan with write_todos, keep scratch notes in files, store lasting " +
      "facts under /memories/, delegate questions to the researcher, and send reports only when asked.",
    tools: [sendReport],
    // Deep Agents adds `write_todos` only for some model profiles; ask for it so planning works with
    // whichever model `DEEP_AGENT_MODEL` names.
    middleware: [todoListMiddleware()],
    backend: new CompositeBackend(new StateBackend(), {
      "/memories/": new StoreBackend({ namespace: memoryNamespaceFor }),
    }),
    interruptOn: { send_report: { allowedDecisions: ["approve", "edit", "reject"] } },
    subagents: [
      {
        name: "researcher",
        description: "Answers a focused research question.",
        systemPrompt: "You are a research assistant. Answer the question you are given concisely.",
      },
      {
        name: "background-researcher",
        description: "Researches a long-running question in the background.",
        graphId: "researcher",
        url: SELF_URL,
        headers: delegatedHeaders,
      },
    ],
  });
}
