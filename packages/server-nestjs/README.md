# @skein-js/nestjs

> NestJS adapter for skein-js — serve the [Agent Protocol](https://github.com/langchain-ai/agent-protocol) from a Nest module.

Part of **[skein-js](../../README.md)** — a TypeScript Agent Protocol server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

A thin transport shim over the framework-agnostic [`@skein-js/agent-protocol`](../agent-protocol)
handler table — it adds no protocol logic, exactly like [`@skein-js/express`](../server-express).
`SkeinModule` mounts the protocol as **middleware**: it claims skein's paths and passes every other
request through to your own controllers, so it composes cleanly with an existing app.

> **Platform:** targets NestJS's default **Express** platform (`@nestjs/platform-express`).

## Install

```bash
npm i @skein-js/nestjs @nestjs/common @nestjs/core @nestjs/platform-express @langchain/langgraph
```

## Embedded in an existing app

```ts
import { Module } from "@nestjs/common";
import { SkeinModule } from "@skein-js/nestjs";

@Module({
  imports: [SkeinModule.forRoot({ config: "./langgraph.json" })],
  controllers: [/* your own controllers */],
})
export class AppModule {}
```

The Agent Protocol is now served (`/threads`, `/assistants`, `/runs`, `/store`, …) alongside your
routes. Call `app.enableCors(...)` as usual if browser clients run on another origin. Enable shutdown
hooks (`app.enableShutdownHooks()`) so the background run worker drains on exit.

### No `langgraph.json`? Pass a graph you already have

`{ deps }` is the alternative to `{ config }`: bring a compiled graph straight from your code — no
config file, no CLI. [`embedInMemoryGraphs`](../server-kit) turns a graph map into the
`ProtocolDeps` the module needs:

```ts
import { Module } from "@nestjs/common";
import { SkeinModule } from "@skein-js/nestjs";
import { embedInMemoryGraphs } from "@skein-js/server-kit";

import { agent } from "./graphs/agent-graph";

@Module({
  imports: [SkeinModule.forRoot({ deps: embedInMemoryGraphs({ agent }) })],
  controllers: [/* your own controllers */],
})
export class AppModule {}
```

Map keys become graph ids. For durable state, swap in `embedPostgresGraphs` (Postgres + Redis) from
[`@skein-js/runtime`](../runtime) — or, if you _do_ have a `langgraph.json` and just want production
drivers, its `buildRuntime`. Full walkthrough: [docs/embedding.md](../../docs/embedding.md).

## Graphs as plain endpoints (non-chat)

For workloads that aren't chat — a classifier, an extractor, a workflow another service calls — there
is a smaller surface: every graph mounted as `POST /invoke/:graph_id`, where the request body **is**
the graph input and the response **is** the final state. No threads, assistants, or runs.

```ts
import { SkeinInvokeModule } from "@skein-js/nestjs";

@Module({ imports: [SkeinInvokeModule.forRoot({ deps })] })
export class AppModule {}
```

Send `Accept: text/event-stream` to stream the steps instead. See
[docs/serving-a-single-graph.md](../../docs/serving-a-single-graph.md).

## Standalone server

A dedicated server whose only job is to serve your graphs:

```ts
import { createNestServer } from "@skein-js/nestjs";

const server = await createNestServer({ config: "./langgraph.json" });
await server.listen(2024);
// on shutdown: await server.close();  // stops the run worker
```

The same `{ deps }` seam applies here — `createNestServer({ deps: embedInMemoryGraphs({ agent }) })`
serves a graph you hold in code, with no `langgraph.json` on disk.

## Streaming

SSE responses write directly to the raw Node response and stream the pre-serialized frames the engine
produced, tearing the run's subscription down on client disconnect.

## API

- **`SkeinModule.forRoot(options): DynamicModule`** — the primary entry point; `imports: [...]` it to
  mount the protocol as middleware alongside your controllers. `options` is `SkeinRuntimeOptions`.
- **`SkeinMiddleware`** — the underlying Nest middleware, for callers wiring their own module.
- **`createNestServer(options): Promise<SkeinNestServer>`** — a standalone server;
  `SkeinNestServer` = `{ app, runtime, listen(port?, host?), close() }`. `close()` closes the Nest app,
  which stops the run worker via the module's shutdown hook.
- **`SKEIN_RUNTIME` / `SKEIN_LOGGER` / `SKEIN_CORS`** — DI tokens; inject `SKEIN_RUNTIME` to reach the
  `ResolvedProtocolRuntime` from your own providers — its `.runtime` is the `ProtocolRuntime`
  (assistants, handlers, worker), plus `.cors`.
- **`SkeinInvokeModule.forRoot(options): DynamicModule`** — the simplified serving surface:
  `POST /invoke/:graph_id` per graph, body-in / final-state-out, for non-chat workloads. Options add
  `prefix` (default `/invoke`) and `streamMode`. Also exports `SkeinInvokeMiddleware` and the
  `SKEIN_INVOKE` token.
- **`SkeinRuntimeOptions`** — the shared seam every adapter accepts: common `{ logger?, cors?, warm? }`
  **plus** either `{ config, importModule? }` (in-memory runtime from a `langgraph.json`) **or**
  `{ deps }` (bring-your-own `ProtocolDeps`). Build `deps` in code with `embedInMemoryGraphs`
  ([`@skein-js/server-kit`](../server-kit)) or `embedPostgresGraphs` ([`@skein-js/runtime`](../runtime)),
  or from a `langgraph.json` with that package's `buildRuntime`.
- Low-level mappers: `toProtocolRequest`, plus `sendNodeResponse` / `sendNodeError` (re-exported from
  [`@skein-js/server-kit`](../server-kit)).

## Learn more

- [`@skein-js/express`](../server-express) — the reference adapter
- [Embedding a graph you already have](../../docs/embedding.md) — the `{ deps }` path, no `langgraph.json`
- [Serving a graph as a plain endpoint](../../docs/serving-a-single-graph.md) — the non-chat surface
- [Building your own adapter](../../docs/building-an-adapter.md) · [skein-js overview](../../docs/index.md)

## License

[Apache-2.0](../../LICENSE)
