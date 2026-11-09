# Answer an agent's questions over MCP

Expose your graph as an MCP tool, ask for human input, and continue the same checkpointed
conversation. Use protocol revision **2026-07-28** with an elicitation-capable client. Ordinary
tools still work with older clients; interrupted tools return an explicit unsupported-client error.

## Serve a question

Export this graph as `greeter` in `langgraph.json`, then run `skein dev`:

```ts
import { Annotation, interrupt, StateGraph } from "@langchain/langgraph";

const state = Annotation.Root({ greeting: Annotation<string> });
export const graph = new StateGraph(state)
  .addNode("ask", () => ({ greeting: `Hello, ${interrupt("What is your name?")}!` }))
  .addEdge("__start__", "ask")
  .addEdge("ask", "__end__")
  .compile();
```

```json
{ "graphs": { "greeter": "./src/greeter.ts:graph" } }
```

## Connect an official client

Install `@modelcontextprotocol/client@2.4.0`. This Node client asks you to answer the form as JSON.
For this graph, enter `{"response":"Ada"}`:

```js
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const terminal = createInterface({ input: stdin, output: stdout });
const client = new Client(
  { name: "interactive-agent", version: "1" },
  {
    versionNegotiation: { mode: { pin: "2026-07-28" } },
    capabilities: { elicitation: { form: {}, url: {} } },
  },
);
client.setRequestHandler("elicitation/create", async ({ params }) => {
  console.log(params.message);
  if (params.mode === "url") {
    console.log(params.url);
    await terminal.question("Open the page, finish the flow, then press Enter: ");
    return { action: "accept" };
  }
  console.log(JSON.stringify(params.requestedSchema, null, 2));
  const answer = await terminal.question("Answer as JSON, or type :decline / :cancel: ");
  if (answer === ":decline") return { action: "decline" };
  if (answer === ":cancel") return { action: "cancel" };
  return { action: "accept", content: JSON.parse(answer) };
});
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:2024/mcp")));
  console.log(await client.callTool({ name: "greeter", arguments: {} }));
} finally {
  await client.close();
  terminal.close();
}
```

The result contains `{"greeting":"Hello, Ada!"}`. In an authenticated deployment, configure the
transport's request headers with the same caller credentials used for the Agent Protocol API.
Each continuation and cached result is authorized again.

## Interrupt shapes

- Strings become forms with one string field named `response`.
- `mcp_elicitation.requests` relays form or URL requests. Maps use MCP field names such as
  `requestedSchema`; array entries can use `key` and `requested_schema`. The graph receives
  `{responses: {key: {action, content}}}`, including declined/cancelled answers.
- LangChain tool reviews become one form per proposed call. Only graph-offered decisions are
  available. Edits accept JSON object arguments and preserve the reviewed tool's name.
- Static breakpoints and unsupported payload/schema shapes return an actionable tool error.
  Use the existing [human-input run/thread APIs](../human-in-the-loop.md) for those graphs.

URL questions require HTTPS, except HTTP on localhost/127.0.0.1/`[::1]`; URLs cannot contain
credentials or exceed 4,096 characters. The client presents the URL; Skein does not open it.
Forms use MCP's restricted flat schemas. Use URL mode for credential or sign-in flows.

## Retry and lifetime

The official client handles rounds automatically. A manual client repeats the same tool/arguments
with the returned `requestState` and answers under their original `inputRequests` keys. All parallel
questions appear together. Missing answers reissue the same questions/state. Invalid answers return
HTTP 400 / `-32602` before execution. Repeated accepted answers replay the result; changed answers
cannot replace an accepted round. An in-flight concurrent answer reports a retry error.
Identical string prompts share an answer key. Use a structured `mcp_elicitation` relay with distinct
request keys when two questions with the same text need independent answers.

Pending continuations are usable for at most 24 hours and completed replays for at most 10 minutes,
bounded by thread TTL/idempotency retention. Expiration does not approve, reject or resume a graph;
existing sweepers reclaim expired records. Thread/run erasure and fresh permission checks also apply.

Bundled memory, SQLite and Postgres stores retain results. A custom store needs the existing optional
`RunRepo.recordResult/getResult` pair for resumable calls; ordinary calls work without it. Memory
remains process-local. Cross-instance safety uses the backend execution gate. Lost inline work is
not automatically replayed: inspect the run and use your application's recovery procedure. Keep
external effects idempotent.

Skein retains its existing thread-retention behavior. Execution remains inline like other wait calls.
Use the [Console](../console.md#runs) to inspect resulting runs, or continue through Agent Protocol.
