# Getting started

A guided, end-to-end path from nothing to a running Agent Protocol server around your LangGraph.js
graph, then to production. If you already have a `langgraph.json` and just want the drop-in, skip to
[Path A](#path-a--i-have-a-langgraphjson-drop-in). If you have a compiled graph in code, take
[Path B](#path-b--i-have-a-graph-in-code-embed). For a terse reference instead of a walkthrough, see
[using-skein.md](./using-skein.md).

## Prerequisites

- **Node ≥ 20** and a package manager (`pnpm`/`npm`).
- A **[LangGraph.js graph](https://docs.langchain.com/oss/javascript/langgraph/graph-api)** — a
  `CompiledStateGraph` from `@langchain/langgraph`. Any graph works; a
  keyless "echo" graph is the fastest way to see the server before wiring a model. The runnable
  [`express-basic`](https://github.com/skein-js/skein-js/tree/main/examples/express-basic) and [`embed-graph`](https://github.com/skein-js/skein-js/tree/main/examples/embed-graph) examples
  ship one.

## Path A — I have a `langgraph.json` (drop-in)

If you already run `langgraph dev`, this is a one-line change. Keep your `langgraph.json` exactly as
it is:

```jsonc
// langgraph.json
{ "graphs": { "agent": "./src/agent.ts:graph" } }
```

Swap the CLI:

```diff
- "dev": "langgraph dev",
+ "dev": "skein dev",
```

```bash
pnpm add -D skein-js
pnpm dev            # skein dev — in-process, hot-reload, on http://localhost:2024
```

`skein dev` loads your TypeScript graphs through vite (no separate loader), hot-reloads on save, and
persists dev state across restarts. This is the full LangGraph CLI surface —
[langgraph-cli-compat.md](./langgraph-cli-compat.md) documents every field and command.

Prefer to mount it inside your own Express/Fastify/Nest/Next app instead of the CLI? Point an adapter
at the same config — `{ config: "./langgraph.json" }` — using the snippets in
[Mount it on your framework](./using-skein.md#mount-it-on-your-framework).

## Path B — I have a graph in code (embed)

No `langgraph.json`, no CLI — bring the compiled graph you already hold and wrap it into a
`ProtocolDeps` with `embedInMemoryGraphs`, then hand `{ deps }` to any adapter:

```ts
// server.ts
import { createExpressServer } from "@skein-js/express";
import { embedInMemoryGraphs } from "@skein-js/server-kit";
import { graph } from "./agent.js"; // your CompiledStateGraph

const server = await createExpressServer({ deps: embedInMemoryGraphs({ agent: graph }) });
await server.listen(2024);
console.log("Agent Protocol on http://localhost:2024");
```

```bash
pnpm add @skein-js/express @skein-js/server-kit @langchain/langgraph
npx tsx server.ts              # or your usual TS runner
```

Both paths produce the **identical** Agent Protocol server. See [embedding.md](./embedding.md) for the
graph-map/factory semantics and how `overrides` swaps in production drivers.

## Talk to your server

With the server running on `:2024`, drive it with the standard SDK — no skein-specific client:

```ts
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });
const thread = await client.threads.create();
const reply = await client.runs.wait(thread.thread_id, "agent", {
  input: { messages: [{ role: "user", content: "hello" }] },
});
console.log(reply);
```

Stream tokens as they arrive instead of waiting:

```ts
for await (const event of client.runs.stream(thread.thread_id, "agent", {
  input: { messages: [{ role: "user", content: "hello" }] },
})) {
  console.log(event.event, event.data);
}
```

`"agent"` is the `assistant_id`, which defaults to the `graph_id`. The full endpoint surface is in
[agent-protocol.md](./agent-protocol.md); the stream wire format is in [streaming.md](./streaming.md).

## Add a web UI

The `useStream` React hook streams over the same server — point it at your URL:

```tsx
import { useStream } from "@langchain/langgraph-sdk/react";

function Chat() {
  const thread = useStream({ apiUrl: "http://localhost:2024", assistantId: "agent" });
  return (
    <button onClick={() => thread.submit({ messages: [{ type: "human", content: "hi" }] })}>
      Send
    </button>
  );
}
```

A browser on a different origin needs CORS enabled — see the
[CORS recipe](./recipes/serving.md#cors-for-a-browser-client). For a same-origin full-stack app (no CORS), the
[`nextjs-app`](https://github.com/skein-js/skein-js/tree/main/examples/nextjs-app) example serves the protocol and the UI from one Next.js app.
See [react-sdk.md](./react-sdk.md).

## Go to production

Dev uses in-memory drivers. For durability and horizontal scale, swap in Postgres (state +
checkpoints) and Redis (run queue + cross-instance streaming). Nothing else about your server
changes — only how `deps` is built.

```ts
// embed path → durable, reading POSTGRES_URI / REDIS_URI from the environment
import { embedPostgresGraphs } from "@skein-js/runtime";
import { createExpressServer } from "@skein-js/express";
import { graph } from "./agent.js";

const { deps, dispose } = await embedPostgresGraphs({ agent: graph });
const server = await createExpressServer({ deps });
await server.listen(2024);
process.on("SIGTERM", async () => {
  await server.close();
  await dispose(); // release the pools it opened
  process.exit(0);
});
```

From a `langgraph.json`, either assemble `deps` with `buildRuntime({ store: "postgres", queue: "redis" })`,
or skip code entirely: `skein dev --store postgres --queue redis`, and `skein build` / `skein up`
to containerize. Redis is optional for a single instance but required to run more than one. Details:
[embedding.md](./embedding.md#going-to-production), [storage.md](./storage.md),
[runs-and-redis.md](./runs-and-redis.md), [deploy.md](./deploy.md).

## Where to next

- [Recipes](./recipes/) — auth, human-in-the-loop, long-term memory, CORS, background runs, deploy.
- [Using skein-js](./using-skein.md) — the terse consumer/agent cheat-sheet.
- [Examples](https://github.com/skein-js/skein-js/tree/main/examples) — a runnable project per framework and pattern.
- [Overview & architecture](./index.md) · [Agent Protocol surface](./agent-protocol.md)
