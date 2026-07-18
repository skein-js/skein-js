# `embed-graph` example

**You have a LangGraph.js graph and never touched the LangGraph Platform.** No `langgraph.json`, no
`langgraph dev`, no CLI project shape — just a compiled graph in your own code. This example turns that
graph into a full Agent Protocol server (threads, runs, SSE streaming, human-in-the-loop, persistence)
that `useStream` / Agent Chat UI / the LangGraph SDK can talk to — in **three lines**.

It's the **in-code** counterpart to [`express-basic`](../express-basic), which serves the same kind of
graph but loads it from a `langgraph.json` via `skein dev`. Same server, two on-ramps.

## The whole backend

```ts
import { createExpressServer } from "@skein-js/express";
import { embedInMemoryGraphs } from "@skein-js/server-kit";
import { graph as echo } from "./echo-graph.js"; // ← your existing compiled graph

const server = await createExpressServer({ deps: embedInMemoryGraphs({ echo }) });
await server.listen(2024);
```

- **`embedInMemoryGraphs({ echo })`** ([@skein-js/server-kit](../../packages/server-kit)) turns a map of
  compiled graphs (keys become assistant/graph ids) into a `ProtocolDeps` backed by in-process drivers —
  the store, run queue, event bus, and checkpointer. No config file, nothing to import from a storage
  package.
- **`{ deps }`** is the seam **every** adapter accepts. Swap `@skein-js/express` for `@skein-js/fastify`,
  `@skein-js/nestjs`, or `@skein-js/nextjs` and the same `deps` mounts unchanged.

See [`src/server.ts`](./src/server.ts) for the runnable version and [`src/echo-graph.ts`](./src/echo-graph.ts)
for the stand-in graph (a deterministic echo — no API key, no network).

## Embed alongside your own routes

Prefer to mount the protocol inside an app you already have rather than a standalone server? Use the
router form instead of `createExpressServer` — one line on your existing Express `app`:

```ts
import { skeinRouter } from "@skein-js/express";
import { embedInMemoryGraphs } from "@skein-js/server-kit";

app.use(skeinRouter({ deps: embedInMemoryGraphs({ echo }) }).router);
```

> **⚠️ Auth is off by default.** `embedInMemoryGraphs` sets no `auth`, so this mounts an
> **unauthenticated** `/threads` · `/runs` · `/store` surface — fine behind your own middleware or on a
> private network, but a public mount is open to anyone. Pass an `auth` engine
> (`embedInMemoryGraphs({ echo }, { auth })`) before you expose it. See
> [docs/embedding.md](../../docs/embedding.md#bring-your-own-drivers-auth-logger).

## Going to production

The in-memory drivers are perfect for a single process (dev, tests, a small app). For durable,
horizontally-scalable state, construct a Postgres store + Redis queue and pass them via `overrides`:

```ts
// store / checkpointer / queue / bus from @skein-js/storage-postgres, @langchain/langgraph-checkpoint-postgres,
// and @skein-js/redis — see docs/embedding.md#going-to-production for the full snippet.
embedInMemoryGraphs({ echo }, { store, checkpointer, queue, bus });
```

## Trade-off vs the `langgraph.json` path

Because a **compiled** graph no longer carries its TypeScript source, the in-code path can't extract
real input/output/state JSON schemas — `embedInMemoryGraphs` returns a minimal `{ graph_id }` stub. That
is enough for everything `useStream` and Agent Chat UI render; only LangGraph Studio's schema-driven
forms degrade. If you need full static schemas, use the [`langgraph.json` path](../../docs/embedding.md)
(`{ config }`) instead. See [docs/embedding.md](../../docs/embedding.md) for the full picture.

## How to run

```bash
pnpm install
pnpm dev                      # → tsx watch src/server.ts, listening on :2024 (PORT overridable)
```

**Smoke test** (no key needed):

```bash
TID=$(curl -s -X POST http://localhost:2024/threads -H 'content-type: application/json' -d '{}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["thread_id"])')

curl -s -X POST "http://localhost:2024/threads/$TID/runs/wait" \
  -H 'content-type: application/json' \
  -d "{\"assistant_id\":\"echo\",\"input\":{\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}}"
```

### Test

```bash
pnpm test     # drives the in-code server with the real @langchain/langgraph-sdk
```
