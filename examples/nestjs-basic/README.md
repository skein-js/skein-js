# `nestjs-basic` example

A **standalone NestJS server** whose only job is to serve your graphs — the NestJS counterpart of
[`express-basic`](../express-basic). Two graphs are declared in one
[`langgraph.json`](./langgraph.json): a deterministic `echo` graph that needs no API key, and a real
Claude `agent` that streams over SSE.

## The whole server

```ts
import "reflect-metadata";
import { createNestServer } from "@skein-js/nestjs";

const server = await createNestServer({ config: "./langgraph.json" });
await server.listen(2024);
```

`createNestServer` spins up a NestJS app (Express platform) with the Agent Protocol mounted at the
root and the background run worker running. See [`src/main.ts`](./src/main.ts).

## How to run

```bash
cp .env.example .env          # only needed for the `agent` graph; `echo` needs nothing
pnpm install
pnpm dev                      # → tsx watch src/main.ts, listening on http://127.0.0.1:2024
```

Then point the `@langchain/langgraph-sdk` `Client` (or React `useStream`) at `http://127.0.0.1:2024`.

## Embedding instead

Want the protocol inside a Nest app that has its own controllers? See [`nestjs-app`](../nestjs-app),
which imports `SkeinModule.forRoot(...)` alongside a REST controller.

## License

[Apache-2.0](../../LICENSE)
