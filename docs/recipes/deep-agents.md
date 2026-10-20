# Deep Agents

> [!WARNING]
> **Experimental.** Deep Agents support is tested end to end against `deepagents` 1.15, but Deep
> Agents itself moves quickly and this integration may change in a minor release. See
> [what is covered](#what-is-covered) before relying on it in production.

Serving a LangChain [Deep Agent](https://docs.langchain.com/oss/javascript/deepagents/overview) —
planning, files, subagents, human approval — with skein.

`createDeepAgent()` returns a compiled LangGraph graph, so there is nothing to adapt: export it, name it
in `langgraph.json`, and skein supplies the checkpointer, the store, streaming and interrupt/resume
around it. There is no `@skein-js/deepagents` package; depend on `deepagents` directly.

```ts
// src/agent.ts
import {
  CompositeBackend,
  createDeepAgent,
  StateBackend,
  StoreBackend,
  type StoreBackendContext,
} from "deepagents";

function memoryNamespace({ config }: StoreBackendContext): string[] {
  const userId = config?.configurable?.langgraph_auth_user_id;
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("Durable memory requires an authenticated user.");
  }
  const component = userId.replace(
    /[^A-Za-z0-9\-_.@+:]/g,
    (character) => `~${character.codePointAt(0)!.toString(16)}~`,
  );
  return ["memories", component];
}

export const graph = createDeepAgent({
  model: "google-genai:gemini-2.5-flash",
  systemPrompt: "You are a careful research assistant.",
  backend: new CompositeBackend(new StateBackend(), {
    "/memories/": new StoreBackend({
      namespace: memoryNamespace,
    }),
  }),
  subagents: [
    { name: "researcher", description: "Answers one question.", systemPrompt: "Be brief." },
  ],
});
```

```json
{ "graphs": { "agent": "./src/agent.ts:graph" }, "auth": { "path": "./src/auth.ts:auth" } }
```

`skein dev` serves it, with the same `langgraph.json` `langgraph dev` reads. A working version is
[`examples/deep-agent`](https://github.com/skein-js/skein-js/tree/main/examples/deep-agent): a research
briefing assistant that plans, delegates research to a subagent, drafts briefings, remembers each
user's preferences, asks before emailing, and runs deep dives in the background. It runs offline with
a scripted model, so it needs no API key.

## What is covered

Tested end to end in the example, through the official `@langchain/langgraph-sdk` client:

- a `createDeepAgent()` export loaded from an unchanged `langgraph.json`, including as a graph factory;
- planning with `write_todos`, and files in thread state that persist across a thread's turns;
- `StoreBackend` files shared across a user's threads and isolated between users;
- a synchronous subagent streamed under its own namespace with `stream_subgraphs`;
- approve / edit / reject on an `interruptOn` tool;
- an async subagent started, checked, updated and cancelled over HTTP on the same server.

Not covered, or deliberately out of scope:

- **The URL-less async transport.** LangGraph Platform runs co-deployed async subagents in process;
  skein needs an explicit `url`.
- **Subgraph streaming on `/invoke`.** Use the run endpoints.
- **Python Deep Agents.** skein loads TypeScript graphs; a Python agent can only be reached as a
  separate Agent Protocol service.
- **Version range.** Tested with `deepagents` 1.15 and `@langchain/langgraph` 1.4.10 or later. Pin
  `deepagents` in your application.

## Files: thread state by default, the store for what outlives a thread

- **`StateBackend`** keeps files in the thread's state. They survive every turn of that thread and
  vanish with it. Deep Agents also writes its own scratch (offloaded tool results, history) to the
  default backend, so state is the right default.
- **`StoreBackend`** keeps files in skein's store — memory under `skein dev`, SQLite or Postgres in
  production — so they are shared across threads. Mount it on a prefix with `CompositeBackend`.

**Give `StoreBackend` an explicit `namespace` on a shared server.** Its default uses assistant
identity when available and otherwise a shared `filesystem` namespace; neither isolates users.
Build it from `langgraph_auth_user_id`: skein stamps that from your [`auth`](./authentication.md) handler and strips it from anything a client sends, so it cannot
be spoofed. With no `auth` configured it is absent — fail rather than pool everyone together. Namespace
components accept only letters, digits and `-_.@+:~`, so encode identities that may contain anything
else. [Memory](./memory.md) covers the store itself.

Secure the HTTP store routes separately: graph backend namespacing does not authorize `/store/items`.
The example denies HTTP store access with `.on("store", () => false)` while retaining the graph's
injected store. Applications needing that HTTP API must scope every store action through `auth`.
Legacy `assistant_id` and `graph_id` configurable values remain application-owned; do not use them as
authenticated identity.

## Streaming subagents

A synchronous subagent runs inside the `task` tool. Ask for subgraph frames and its progress streams
alongside the main agent's, under the tool call's namespace:

```ts
for await (const chunk of client.runs.stream(threadId, "agent", {
  input,
  streamMode: ["updates", "messages-tuple"],
  streamSubgraphs: true,
})) {
  chunk.event; // "updates" from the main agent, "updates|tools:<id>" from the subagent
}
```

The SDK's UI helpers route on these names. See [subgraphs and subagents](../streaming.md#subgraphs-and-subagents).

## Planning

`write_todos` comes from LangChain's todo-list middleware. Deep Agents adds it only for some model
profiles, so pass it yourself when you rely on planning:

```ts
import { todoListMiddleware } from "langchain";

createDeepAgent({ /* … */ middleware: [todoListMiddleware()] });
```

## Human approval

`interruptOn` pauses before a tool runs; the run ends `interrupted`. Resume it with a decision per
pending action:

```ts
createDeepAgent({
  /* … */ interruptOn: { send_briefing: { allowedDecisions: ["approve", "edit", "reject"] } },
});

await client.runs.wait(threadId, "agent", {
  command: { resume: { decisions: [{ type: "approve" }] } },
  // or { type: "edit", editedAction: { name: "send_briefing", args: { … } } }
  // or { type: "reject", message: "not this week" }
});
```

See [human-in-the-loop](../human-in-the-loop.md).

## Async subagents

An async subagent is another graph, started and polled over the Agent Protocol. Give it an explicit
`url` and credentials scoped to the originating caller. Build the main agent as a graph factory so
upstream's async client is constructed with that caller's credentials. For the example's demo auth:

```ts
import type { RunnableConfig } from "@langchain/core/runnables";
import { createDeepAgent } from "deepagents";

export function graph(config: RunnableConfig) {
  const userId = config.configurable?.langgraph_auth_user_id;
  // An empty identity is rejected by the demo auth handler, including on an unbound factory.
  const headers = { "x-user": typeof userId === "string" ? userId : "" };
  return createDeepAgent({
    subagents: [
      {
        name: "deep-researcher",
        description: "Runs a longer research investigation in the background.",
        graphId: "researcher",
        url: process.env.SKEIN_URL ?? "http://127.0.0.1:2024",
        headers,
      },
    ],
  });
}
```

In production, mint or forward a caller-scoped credential your auth handler verifies. A shared
service credential would give user-supplied `asyncTasks` records authority over other callers' child
runs. Keep receiving thread ownership checks in place; task identifiers are not authorization.

Every call is an ordinary route — thread create, run create, run get, thread state, a new run with
`multitask_strategy: "interrupt"` to update, and cancel — so it works against any skein deployment. The
URL-less, in-process transport LangGraph Platform offers is not recreated. Each started task is a
background run, so give the server enough [run concurrency](../runs-and-redis.md#run-concurrency) for the
main agent and its children at once.

## Shell and code execution

Use a remote sandbox provider for anything that executes commands. **Never use `LocalShellBackend` or
`FilesystemBackend` on a shared server**: both act directly on the host skein runs on, with that
process's permissions, for whoever can reach the agent. State and store backends need no sandbox.

## Dependency security

This workspace applies a local patch for the unpatched `braces` nesting advisory in Deep Agents'
glob dependency. Applications copying this example must audit their own lockfiles and apply the
patch in their own package-manager configuration; workspace patches do not propagate through a
published package or an exported artifact. See the [dependency audit](../audits/dependency-advisories-2026-10-20.md)
for the patch, compatibility details, and current scan results.
