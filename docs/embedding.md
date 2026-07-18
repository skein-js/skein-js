# Embedding a graph you already have — the in-code path

> **User guide.** skein-js has **two on-ramps**. If you already run the LangGraph CLI, the
> [drop-in](./langgraph-cli-compat.md) (`langgraph dev` → `skein dev`, unchanged `langgraph.json`) is
> for you. This doc is the **other** on-ramp: you have a LangGraph.js graph in your own app and never
> adopted the LangGraph Platform's project shape — no `langgraph.json`, no CLI. Bring the compiled
> graph in code and get the same Agent Protocol server in a few lines.

## Contents

- [Two on-ramps](#two-on-ramps)
- [The whole thing](#the-whole-thing)
- [The graph map](#the-graph-map)
- [Standalone or embedded](#standalone-or-embedded)
- [Bring your own drivers, auth, logger](#bring-your-own-drivers-auth-logger)
- [Going to production](#going-to-production)
- [The one trade-off: schemas](#the-one-trade-off-schemas)
- [API reference](#api-reference)
- [See also](#see-also)

## Two on-ramps

|                      | Drop-in CLI (`{ config }`)                            | In-code embedding (`{ deps }`)                                  |
| -------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| You start from       | a `langgraph.json` + the `skein` CLI                  | a **compiled graph object** in your own code                    |
| Wiring               | `createExpressServer({ config: "./langgraph.json" })` | `createExpressServer({ deps: embedInMemoryGraphs({ graph }) })` |
| Graph loading        | `path:export` resolved from disk (vite/TS loader)     | you already hold the graph — nothing is loaded from disk        |
| Best for             | migrating off / comparing against the LangGraph CLI   | greenfield apps, or anyone who never used the Platform          |
| Static graph schemas | ✅ extracted from source                              | 🟡 stubbed (see [trade-off](#the-one-trade-off-schemas))        |

Both produce the **exact same** Agent Protocol server — same threads/runs/streaming/HITL/persistence,
same `useStream` / Agent Chat UI / LangGraph SDK compatibility. The only difference is how graphs get
in and how `ProtocolDeps` is assembled. Everything downstream is identical.

## The whole thing

```ts
import { createExpressServer } from "@skein-js/express";
import { embedInMemoryGraphs } from "@skein-js/server-kit";
import { graph } from "./my-graph.js"; // ← your existing `new StateGraph(...).compile()`

const server = await createExpressServer({ deps: embedInMemoryGraphs({ agent: graph }) });
await server.listen(2024);
```

That's a full server. Point any Agent Protocol client at `http://localhost:2024`:

```ts
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });
const thread = await client.threads.create();
await client.runs.wait(thread.thread_id, "agent", {
  input: { messages: [{ role: "user", content: "hello" }] },
});
```

`embedInMemoryGraphs` ([`@skein-js/server-kit`](../packages/server-kit)) turns a **graph map** into a
`ProtocolDeps` backed by in-process drivers — the store, run queue, event bus, and checkpointer. No
config file, and nothing to import from a storage package. `{ deps }` is the seam **every** adapter
accepts, so the same `deps` mounts on Express, Fastify, NestJS, or Next.js unchanged.

Runnable version: [`examples/embed-graph`](../examples/embed-graph).

> **⚠️ Auth is off by default.** `embedInMemoryGraphs` sets no `auth`, so the server it produces
> **authenticates nothing** — every request is allowed (the same default as a `langgraph.json` with no
> `auth` block). That's fine behind your own middleware or on a private network, but mounting `{ deps }`
> on a **public** app exposes `/threads`, `/runs`, and `/store` to anyone — including running your graph
> (spending model tokens) and reading/writing the long-term store. Add an `auth` engine before you go
> public — see [Bring your own drivers, auth, logger](#bring-your-own-drivers-auth-logger).

## The graph map

Keys become graph ids (one auto-registered assistant each). Values are either a **compiled graph** or a
**factory** — a function that builds one, called with the run's `configurable`. Factories are how you
defer expensive or key-requiring construction until a graph is actually run:

```ts
embedInMemoryGraphs({
  echo, // a compiled graph, imported eagerly
  // built lazily on first use — keeps a keyless boot when the model needs an API key:
  agent: async () => (await import("./agent-graph.js")).graph,
  // or per-run config: (config) => buildGraph(config.configurable?.model),
});
```

A concretely-typed `.compile()` result (e.g. from `MessagesAnnotation`) is accepted **without a cast** —
the [`EmbeddableGraph`](#api-reference) type leaves the graph's generics open on purpose.

## Standalone or embedded

`{ deps }` works with every adapter, in both its standalone and embedded form:

```ts
const deps = embedInMemoryGraphs({ agent: graph });

// Express — standalone server, or mounted on your existing app:
await createExpressServer({ deps }).listen(2024);
app.use(skeinRouter({ deps }).router);

// Fastify — plugin under a prefix:
await app.register(skeinPlugin, { prefix: "/agent", deps });

// NestJS — dynamic module:
@Module({ imports: [SkeinModule.forRoot({ deps })] })

// Next.js — App Router catch-all (same-origin, no second server):
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createSkeinRouteHandlers({ deps });
```

The Next.js App Router case is the lightest full-stack story — an 11-line `route.ts` serving the
protocol same-origin behind a `useStream` UI. See [`examples/nextjs-app`](../examples/nextjs-app).

## Bring your own drivers, auth, logger

`embedInMemoryGraphs(graphs, overrides)` takes a second argument that replaces any field of
`ProtocolDeps` except `graphs` (the first argument is the single source of graphs) — a driver, an
`auth` engine, a `logger`. Supplying `auth` is how you close the open-by-default surface from the
warning above:

```ts
import { loadAuthEngine } from "@skein-js/config";

embedInMemoryGraphs({ agent: graph }, { auth: await loadAuthEngine(/* … */), logger: myLogger });
```

## Going to production

The in-memory drivers are ideal for a single long-lived process (dev, tests, a small app). For durable,
horizontally-scalable state, construct a Postgres store + Redis queue and pass them as `overrides`:

```ts
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { RedisRunEventBus, RedisRunQueue } from "@skein-js/redis";
import { createPostgresPool, PostgresSkeinStore } from "@skein-js/storage-postgres";

const checkpointer = new PostgresSaver(createPostgresPool(process.env.POSTGRES_URI!));
await checkpointer.setup();

const deps = embedInMemoryGraphs(
  { agent: graph },
  {
    store: await PostgresSkeinStore.connect(process.env.POSTGRES_URI!),
    checkpointer,
    queue: new RedisRunQueue(process.env.REDIS_URI!),
    bus: new RedisRunEventBus(process.env.REDIS_URI!),
  },
);
```

If you _do_ have a `langgraph.json`, [`@skein-js/runtime`](../packages/runtime)'s
`buildRuntime({ configPath, store: "postgres", queue: "redis" })` assembles all of these for you.

Serverless/edge deploys need this: the in-memory drivers (and the background run worker) assume one warm
process, so they don't survive a function that scales to zero. See
[storage.md](./storage.md) and [runs-and-redis.md](./runs-and-redis.md).

## The one trade-off: schemas

A **compiled** graph no longer carries its TypeScript source, so the in-code path can't extract real
input/output/state JSON schemas — `embedInMemoryGraphs` returns a minimal `{ graph_id }` stub for the
assistants introspection endpoints. This is enough for **everything `useStream` and Agent Chat UI
render**; the only thing that degrades is **LangGraph Studio's** schema-driven forms and its graph/step
views. If you need full static schemas, use the [`{ config }` path](./langgraph-cli-compat.md) — the
`langgraph.json` loader runs `getStaticGraphSchema` over the graph source at build time.

## API reference

From [`@skein-js/server-kit`](../packages/server-kit):

```ts
// Build a ProtocolDeps around in-process drivers. Pass a graph map OR a ready GraphResolver.
function embedInMemoryGraphs(
  graphs: GraphResolver | Record<string, EmbeddableGraph>,
  overrides?: Omit<Partial<ProtocolDeps>, "graphs">, // every driver/auth/logger except `graphs`
): ProtocolDeps;

// Turn just the graph map into a GraphResolver (the ids/load/schemas seam the engine consumes).
function graphMapToResolver(graphs: Record<string, EmbeddableGraph>): GraphResolver;

// A graph you can embed: any compiled LangGraph.js graph, or a factory that builds one per run.
type EmbeddableGraph = CompiledGraph<any> | ((config: { configurable?: Record<string, unknown> }) => …);
```

> `embedInMemoryGraphs` was previously named `createInMemoryDeps`. The old name is still exported as a
> deprecated alias, so existing imports keep working — prefer `embedInMemoryGraphs` in new code.

`graphMapToResolver` is useful on its own when you want the resolver but your **own** `ProtocolDeps`
(e.g. Postgres/Redis drivers): `buildRuntime`-style deps with `graphs: graphMapToResolver({ agent })`.

## See also

- [langgraph-cli-compat.md](./langgraph-cli-compat.md) — the other on-ramp (drop-in CLI + `langgraph.json`)
- [agent-protocol.md](./agent-protocol.md) — the endpoints you get either way
- [building-an-adapter.md](./building-an-adapter.md) — putting the engine on any HTTP framework
- [storage.md](./storage.md) · [runs-and-redis.md](./runs-and-redis.md) — swapping in production drivers
- [`examples/embed-graph`](../examples/embed-graph) · [`examples/nextjs-app`](../examples/nextjs-app)
