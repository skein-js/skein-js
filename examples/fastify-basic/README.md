# `fastify-basic` example

A **standalone Fastify server** whose only job is to serve your graphs — the Fastify counterpart of
[`express-basic`](../express-basic). Two graphs are declared in one
[`langgraph.json`](./langgraph.json): a deterministic `echo` graph that needs no API key, and a real
Claude `agent` that streams over SSE.

| Graph id | File                                         | Needs a key?           | Good for                                                         |
| -------- | -------------------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| `echo`   | [`src/echo-graph.ts`](./src/echo-graph.ts)   | ❌ no                  | Zero-setup protocol/streaming playground — echoes your message.  |
| `agent`  | [`src/agent-graph.ts`](./src/agent-graph.ts) | ✅ `ANTHROPIC_API_KEY` | A real Claude ReAct agent with a tool; token streaming over SSE. |

## The whole server

```ts
import { createFastifyServer } from "@skein-js/fastify";

const server = await createFastifyServer({ config: "./langgraph.json" });
await server.listen(2024);
```

That's it — `createFastifyServer` mounts the Agent Protocol at the root and starts the background run
worker. See [`src/server.ts`](./src/server.ts).

## How to run

```bash
cp .env.example .env          # only needed for the `agent` graph; `echo` needs nothing
pnpm install
pnpm dev                      # → tsx watch src/server.ts, listening on http://127.0.0.1:2024
```

Then point the [`@langchain/langgraph-sdk`](https://www.npmjs.com/package/@langchain/langgraph-sdk)
`Client` (or React `useStream`) at `http://127.0.0.1:2024`:

```ts
import { Client } from "@langchain/langgraph-sdk";
const client = new Client({ apiUrl: "http://127.0.0.1:2024" });
const thread = await client.threads.create();
const reply = await client.runs.wait(thread.thread_id, "echo", {
  input: { messages: [{ role: "user", content: "hello" }] },
});
```

## Embedding instead

Want the protocol inside an app that has its own routes? See [`fastify-app`](../fastify-app), which
registers the `skeinPlugin` alongside a REST API.

## License

[Apache-2.0](../../LICENSE)
