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
routes. Pass `{ deps }` instead of `{ config }` to bring your own persistent drivers (Postgres +
Redis) via [`@skein-js/runtime`](../runtime)'s `buildRuntime`. Call `app.enableCors(...)` as usual if
browser clients run on another origin. Enable shutdown hooks (`app.enableShutdownHooks()`) so the
background run worker drains on exit.

## Standalone server

A dedicated server whose only job is to serve your graphs:

```ts
import { createNestServer } from "@skein-js/nestjs";

const server = await createNestServer({ config: "./langgraph.json" });
await server.listen(2024);
// on shutdown: await server.close();  // stops the run worker
```

## Streaming

SSE responses write directly to the raw Node response and stream the pre-serialized frames the engine
produced, tearing the run's subscription down on client disconnect.

## Learn more

- [`@skein-js/express`](../server-express) — the reference adapter
- [Building your own adapter](../../docs/building-an-adapter.md) · [skein-js overview](../../docs/index.md)

## License

[Apache-2.0](../../LICENSE)
