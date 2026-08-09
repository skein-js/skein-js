# Serving the Agent Protocol with your own agent

skein-js is built for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), but the protocol
engine is not. `@skein-js/agent-protocol` installs with **no graph runtime** — no
`@langchain/langgraph`, no `@langchain/langgraph-checkpoint`, in the emitted JavaScript _or_ the
generated type declarations. Both are asserted in CI by
[`static-imports.test.ts`](https://github.com/skein-js/skein-js/blob/main/packages/test-support/src/static-imports.test.ts),
as two separate checks, because they fail independently.

So if you have an agent of your own — an AI SDK loop, a Mastra workflow, a hand-rolled tool loop —
you can serve the Agent Protocol with it, and every LangGraph client
([`useStream`](./react-sdk.md), Agent Chat UI, LangGraph Studio) works against it unchanged.

This page is the runtime seam. [Building your own adapter](./building-an-adapter.md) is the transport
seam — one page per seam.

## What you implement

The engine drives an **`AgentGraph`**. Two methods are required; the rest are optional, and the split
is empirical rather than designed — it is what a measured, working server actually needed.

```ts
interface AgentGraph {
  // REQUIRED — run the agent, yielding one chunk per step.
  stream(
    input: unknown,
    options?: unknown,
  ): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;

  // REQUIRED — the thread's authoritative state after a run.
  getState(config: { configurable?: Record<string, unknown> }): Promise<AgentStateSnapshot>;

  // Optional. Each maps to endpoints; see the capability table below.
  getStateHistory?(config, options?): AsyncIterable<AgentStateSnapshot>;
  updateState?(config, values, asNode?): Promise<{ configurable?: Record<string, unknown> }>;
  bulkUpdateState?(config, supersteps): Promise<{ configurable?: Record<string, unknown> }>;
  streamEvents?(input, options?): AsyncIterable<unknown>;
  invoke?(input, options?): Promise<unknown>;
  getGraphAsync?(options?): Promise<{ toJSON(): unknown }>;
  getSubgraphsAsync?(namespace?, recurse?): AsyncIterable<[string, unknown]>;
}
```

A LangGraph `CompiledGraph` satisfies this by construction — that is what keeps the type additive.

### Streaming: the one trick worth knowing

`stream` yields whatever you like, but a **`[mode, data]` tuple** is unwrapped into that stream mode.
`StreamMode` is a plain string union from `@skein-js/core`; nothing LangGraph participates. So a
plain async generator produces correct SSE:

```ts
async *stream(input, options) {
  const threadId = String(options?.configurable?.thread_id ?? "");
  for await (const step of myAgent(input)) {
    yield ["values", step];   // -> event: values
  }
}
```

Anything that is _not_ such a tuple is published as an `updates` payload.

### State: seven fields

`getState` returns an `AgentStateSnapshot`. skein projects it onto the wire `ThreadState`, and reads
exactly these:

| Field          | Meaning                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `values`       | current state — what `GET /threads/{id}` mirrors                                               |
| `next`         | nodes still to run. **Non-empty ⇒ the run is reported `interrupted`**                          |
| `tasks`        | `{ id, name, error?, interrupts, result? }` — carries pending interrupts and per-node failures |
| `config`       | its `configurable` carries the checkpoint coordinates                                          |
| `parentConfig` | the parent snapshot's config, if any                                                           |
| `metadata`     | passed through untouched                                                                       |
| `createdAt`    | ISO timestamp                                                                                  |

Only `values`, `next` and `tasks` are required. `{ values: state, next: [], tasks: [] }` is a valid
snapshot for an agent that does not pause.

## Capabilities: what an absent method does

An optional method you do not implement is a **handled 422**, not a crash:

```json
{
  "status": 422,
  "message": "This agent does not implement \"updateState\", which this endpoint requires.",
  "code": "agent_capability_missing",
  "details": { "capability": "updateState" }
}
```

| Method              | Endpoints it serves                      |
| ------------------- | ---------------------------------------- |
| `getStateHistory`   | `GET`/`POST /threads/{id}/history`       |
| `updateState`       | `POST /threads/{id}/state` (time travel) |
| `bulkUpdateState`   | `POST /threads` carrying `supersteps`    |
| `streamEvents`      | the `events` stream mode                 |
| `invoke`            | `POST /invoke/{graph_id}`                |
| `getGraphAsync`     | `GET /assistants/{id}/graph`             |
| `getSubgraphsAsync` | `GET /assistants/{id}/subgraphs`         |

**Why 422 and not 501.** `@langchain/langgraph-sdk`'s `AsyncCaller` retries any status outside
`STATUS_NO_RETRY = [400,401,402,403,404,405,406,407,408,409,422]`. A 501 would cost the official
client five requests and exponential backoff to learn a fact that cannot change on retry. 422 is in
that list, and "the request cannot be processed as sent" is honest: the route exists, the body is
fine, this agent cannot serve it.

`GET /threads/{id}/state` is deliberately **not** in that table: it falls back to `getState` when
`getStateHistory` is absent, so the required tier alone serves it.

## A complete server

No `langgraph.json`, no CLI, no `@langchain/*` in your file:

```ts
import type { AgentGraph, AgentStateSnapshot } from "@skein-js/agent-protocol";
import { createExpressServer } from "@skein-js/express";
import { embedInMemoryGraphs } from "@skein-js/server-kit";

const stateByThread = new Map<string, unknown>();
const threadId = (c?: { configurable?: Record<string, unknown> }) =>
  String(c?.configurable?.["thread_id"] ?? "");

const agent: AgentGraph = {
  stream(input, options) {
    const id = threadId(options as { configurable?: Record<string, unknown> });
    return (async function* () {
      const reply = { messages: [{ role: "ai", content: "hello" }] };
      stateByThread.set(id, reply);
      yield ["values", reply];
    })();
  },
  async getState(config): Promise<AgentStateSnapshot> {
    return { values: stateByThread.get(threadId(config)) ?? {}, next: [], tasks: [] };
  },
};

// Pass a `GraphResolver` — not a graph map. A map's values are LangGraph compiled graphs by type.
const deps = embedInMemoryGraphs({
  ids: ["chat"],
  load: async () => agent,
  schemas: async (id) => ({ [id]: { graph_id: id } }) as never,
});

await (await createExpressServer({ deps })).listen(2024);
```

That serves `POST /threads`, `GET /threads/{id}`, `POST /runs/wait`, `POST /runs/stream` (SSE with
replay), `GET /threads/{id}/state`, `GET /info`, plus auth, `Idempotency-Key`, crons, the store, and
multitask strategies — none of which you implement.

`storeBridge`, `ephemeralCheckpointer` and `cloneCheckpoint` on `ProtocolDeps` are all **optional**
and runtime-specific; omit them. `checkpointer` is a structural `ThreadCheckpointer` (five methods:
`getTuple`, `list`, `put`, `putWrites`, `deleteThread`) — supply a stub if your agent keeps its own
state, or a real one if you want thread copy / prune / rollback.

## Interrupts and resume

`POST /runs` with a `command` body resumes an interrupted run. The engine does **not** construct a
runtime's command type — that would be a runtime import. It hands your agent a branded envelope:

```ts
import { isAgentCommand, agentCommandPayload } from "@skein-js/agent-protocol";

stream(input, options) {
  if (isAgentCommand(input)) {
    const { resume, update, goto } = agentCommandPayload(input);
    // …resume your agent with `resume`
  }
}
```

Use `agentCommandPayload` rather than reading fields off the envelope: the wire schema passes unknown
fields through, and the payload is the complete, unbranded object.

To report a pause, return a snapshot with non-empty `next` (or tasks carrying `interrupts`).

## What you cannot change

- **The wire types.** They are `@langchain/langgraph-sdk`'s, deliberately — that is why every
  LangGraph client works against skein by construction. See [reuse](./reuse.md).
- **The run lifecycle** — statuses, multitask strategies, the SSE frame envelope.
- **The auth model** — see [the Agent Protocol reference](./agent-protocol.md). Auth is the
  deployment's concern, not the agent's; a runner never sees it.

## Known limits

- **`events` mode is effectively LangChain-only.** Its demux keys on `on_chain_stream`, root
  `run_id`, and `langsmith:hidden` tags. Your agent may yield `mode: "events"` chunks, but their
  payload is your contract with your own clients — `useStream` will not render them as token events.
- **`useStream` hydration** calls `GET /threads/{id}/state`. Implement `getState` well (it is
  required anyway) or hydration is empty.
- **Time travel** needs `updateState` + `getStateHistory`. Without them, `checkpoint_id` on a run is
  ignored rather than honoured.

## The reference implementation

[`@skein-js/langgraph`](https://github.com/skein-js/skein-js/tree/main/packages/langgraph) is one
implementation of this seam, and it imports only `@skein-js/agent-protocol`'s public entry point —
no privileged access. If it ever needs an internal, the internal is missing from the public API.
Reading it is the fastest way to see what a complete binding looks like.
