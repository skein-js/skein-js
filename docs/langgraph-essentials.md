# LangGraph essentials

skein-js serves LangGraph.js graphs **unchanged**. It wraps none of the API below, adds no dialect
of its own, and the graph you write here runs on LangGraph Platform without an edit. This page is
the shallow dive: the parts of LangGraph you need to read and modify your own agent, each with a
link to the LangChain docs that own it in full.

It is not a LangGraph tutorial. When a section is the one you actually need,
[Thinking in LangGraph](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)
and the reference behind each **Go deeper** link are where to spend the time.

## The smallest graph

State, a node, edges and `.compile()` — the first four concepts below, all in the graph
[`npm create skein-js`](./scaffolding.md) scaffolds for you:

```ts
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";

function echo(state: typeof MessagesAnnotation.State): { messages: BaseMessage[] } {
  const last = state.messages.at(-1);
  const text = typeof last?.content === "string" ? last.content : "";
  return { messages: [new AIMessage(`echo: ${text}`)] };
}

export const graph = new StateGraph(MessagesAnnotation)
  .addNode("echo", echo)
  .addEdge("__start__", "echo")
  .addEdge("echo", "__end__")
  .compile();
```

## State and channels

State is the data flowing through your agent, declared as **channels**. `MessagesAnnotation` is the
ready-made one for chat — a list of messages that appends. When you need your own shape, declare it:

```ts
import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

const State = Annotation.Root({
  ...MessagesAnnotation.spec,
  draft: Annotation<string>(),
});
```

Keep **raw data in state and format prompts inside nodes**. Everything in state is checkpointed on
every step, so a formatted prompt stored in a channel is a copy you pay for forever.

**Go deeper →** [Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)

## Reducers

A channel's reducer decides what happens when a node returns a value for it: replace, or combine.
The `messages` reducer appends, which is why returning one message adds it rather than truncating
the conversation to a single entry.

```ts
// appends to messages — it does not overwrite the list
return { messages: [new AIMessage("done")] };
```

This bites in one specific place: **editing state by hand**, from the API or the
[console](./console.md). You write through the same reducers, so patching `{ messages: [...] }` to
fix a transcript appends to it. Use `asNode` to attribute the write to a node whose reducer does
what you meant. See [state & context](./state-and-context.md#state-what-the-agent-knows-right-now).

**Go deeper →** [Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)

## Nodes

A node is a plain function. It receives the current state and returns **only the part that
changed** — never the whole state. Because it is a plain function, you can import it in a test,
call it with a literal, and step through it in a debugger without a server anywhere.

Nodes may be async, and they may reach for injected resources — see
[persistence](#persistence-the-checkpointer-and-the-store) below.

**Go deeper →** [Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)

## Edges and conditional edges

Edges say what runs next. `__start__` and `__end__` are the built-in entry and exit points. A
straight line needs only `addEdge`; branching — the reason it is a graph at all — uses
`addConditionalEdges` with a function that returns the name of the next node:

```ts
const graph = new StateGraph(State)
  .addNode("classify", classify)
  .addNode("approve", approve)
  .addNode("send", send)
  .addEdge("__start__", "classify")
  .addConditionalEdges("classify", (state) => (state.needsApproval ? "approve" : "send"))
  .compile();
```

Cycles are allowed and expected: an agent loop is a node that routes back to the model until there
is nothing left to call.

**Go deeper →**
[Workflows and agents](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents)

## `.compile()`

`.compile()` turns the definition into something runnable, and **what it returns is what skein
serves** — the value your `langgraph.json` points at:

```json
{ "graphs": { "agent": "./src/agent-graph.ts:graph" } }
```

Do not pass a `checkpointer` or `store` to `.compile()` yourself. skein injects both per run; see
below.

**Go deeper →** [Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)

## Prebuilt agents

Most agents are the same loop: call the model, run the tool it asked for, call the model again.
`createAgent` is that loop, already written:

```ts
import { createAgent } from "langchain";

export const graph = createAgent({
  model: "anthropic:claude-sonnet-5",
  tools: [getWeather],
});
```

It returns a compiled graph like any other, so everything skein does — threads, streaming,
interrupts, memory — works against it unchanged.

> [!NOTE]
> You will meet **`createReactAgent`** from `@langchain/langgraph/prebuilt` in older code — including
> skein's own examples and scaffolder, which have not been migrated yet. It still works, but it is
> `@deprecated` as of `@langchain/langgraph` 1.4: it moved to the `langchain` package and was renamed.
> The parameter changed too — `llm` became `model`, which also accepts a `"provider:model"` string.

**Go deeper →** [Agents](https://docs.langchain.com/oss/javascript/langchain/agents)

## Tools

A tool is a function plus the metadata a model needs to decide when to call it:

```ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const getWeather = tool(async ({ city }: { city: string }) => `It's 21°C in ${city}.`, {
  name: "get_weather",
  description: "Get the current weather for a city.",
  schema: z.object({ city: z.string().describe("City name, e.g. 'Nairobi'") }),
});
```

The `description` and the schema's `.describe()` calls are the model's **only** context for the
tool. Write them for a reader who knows nothing else, because that is exactly the situation.

**Go deeper →** [Tools](https://docs.langchain.com/oss/javascript/langchain/tools)

## `interrupt()` and commands

`interrupt()` pauses the graph from inside a node. The run **ends** on a checkpoint — no connection
held, no timer running — and resuming later returns your supplied value from the `interrupt()`
call:

```ts
import { interrupt } from "@langchain/langgraph";

const answer = interrupt({ question: "Send this email?", draft: state.draft });
```

This is the concept most dependent on the checkpointer: without one, `interrupt()` has nowhere to
park and resume silently no-ops. skein exposes resuming as `command: { resume }` on a normal run
create, plus `resume` / `update` / `goto`.

**Go deeper →** [Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) ·
skein side: [human-in-the-loop](./human-in-the-loop.md)

## Subgraphs

A compiled graph can be a node in another graph. That is how you keep a large agent readable — a
research step, a drafting step, an approval step, each its own graph with its own state, composed
at the top. skein serves the outer graph; the nesting is invisible to the protocol.

**Go deeper →** [Subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs)

## Stream modes

`graph.stream()` takes a `streamMode` — `values`, `updates`, `messages`, `custom`, `events`,
`debug` — and you may request several at once. skein maps each of them onto Agent Protocol SSE
frames without translation, which is why the LangChain SDKs and `useStream` work against a skein
server with only a URL change.

**Go deeper →** [Streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming) ·
skein side: [streaming](./streaming.md)

## Persistence: the checkpointer and the store

LangGraph defines two persistence interfaces, and **skein supplies both** — a checkpointer bound to
the thread, and a `BaseStore` bridged from whichever [storage driver](./storage.md) you configured.
Your nodes reach the store the usual LangGraph way:

```ts
import { getStore, type LangGraphRunnableConfig } from "@langchain/langgraph";

// In a node, the store arrives on the config…
async function remember(state: State, config: LangGraphRunnableConfig) {
  await config.store?.put(["users", userId], "profile", { name: state.name });
}

// …and inside a tool, where there's no config argument, reach for getStore().
async function saveName(name: string) {
  await getStore().put(["users", userId], "profile", { name });
}
```

`getStore()` reads the run currently executing, so call it **inside** the function. At module scope
there is no run yet and it throws on import.

> [!WARNING]
> **Do not construct your own checkpointer or store and pass them to `.compile()`.** It is the
> single most common way this breaks: the graph then persists somewhere skein does not know about,
> so threads, time travel and interrupt-resume all read the wrong state. Let the injection happen.

**Go deeper →** [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) ·
skein side: [state & context](./state-and-context.md), [storage](./storage.md)

## Who owns what

| LangGraph owns                        | skein-js owns                                       |
| ------------------------------------- | --------------------------------------------------- |
| State, channels, reducers             | Threads, runs, assistants and their versions        |
| Nodes, edges, subgraphs, `.compile()` | The HTTP surface — Agent Protocol, SSE, the console |
| Tools and the agent loop              | The run queue, multitask strategies, cancellation   |
| `interrupt()` and commands            | Crons, run-completion webhooks, idempotency         |
| Stream modes                          | Storage drivers, and injecting them per run         |

The line matters when something goes wrong: if it is about what your graph _computed_, it is a
LangGraph question. If it is about what got _served, stored or scheduled_, it is ours.

## See also

- [Building blocks](./building-blocks.md) — the skein-side map of the same territory
- [Your first agent](./your-first-agent.md) — build one from an empty directory
- [LangGraph CLI compatibility](./langgraph-cli-compat.md) — what `langgraph.json` supports
- [Building a runner](./building-a-runner.md) — serving the protocol from something that isn't
  LangGraph
