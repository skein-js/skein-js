# `nestjs-app` example

skein-js **embedded in an existing NestJS app**. The app keeps its own REST controller
(`GET/POST /api/todos`) and _also_ serves the Agent Protocol via `SkeinModule.forRoot(...)`. The
module mounts as middleware that claims only skein's protocol paths (`/threads`, `/assistants`,
`/runs`, `/store`) and passes everything else through — so your controllers are untouched.

```ts
import { Module } from "@nestjs/common";
import { SkeinModule } from "@skein-js/nestjs";

@Module({
  imports: [SkeinModule.forRoot({ config: "./langgraph.json" })],
  controllers: [TodosController], // your own controllers
})
class AppModule {}
```

See [`src/main.ts`](./src/main.ts). The same two graphs as [`nestjs-basic`](../nestjs-basic) are
served (`echo`, `agent`).

## What you'll learn

- How to serve the Agent Protocol from a NestJS app that **already has its own controllers**, using
  `SkeinModule.forRoot(...)` in your root module.
- Why the module mounts as **middleware** that claims only skein's paths and passes everything else
  through — so your `TodosController` is untouched and there's no route collision.
- How the protocol follows your app's `setGlobalPrefix(...)`, and where to enable shutdown hooks so
  the background run worker drains on exit.

## What to look at

| File                                     | Why                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| [`src/main.ts`](./src/main.ts)           | Bootstraps Nest, imports `SkeinModule`, sets the global prefix, enables shutdown hooks. |
| [`langgraph.json`](./langgraph.json)     | The two graphs (`echo`, `agent`) the module serves.                                     |
| [`src/main.test.ts`](./src/main.test.ts) | Proves the controller and the protocol coexist in one app.                              |

## How to run

```bash
cp .env.example .env          # only needed for the `agent` graph; `echo` needs nothing
pnpm install
pnpm dev                      # → tsx watch src/main.ts
```

The app calls `app.setGlobalPrefix("api")`, and the protocol follows it automatically:

- The app's REST: `http://127.0.0.1:2024/api/todos`
- The Agent Protocol: point a client at `http://127.0.0.1:2024/api`

> **Tip:** `app.setGlobalPrefix(...)` is how you relocate the protocol — `SkeinModule` reads it from
> Nest and needs no configuration of its own. Nest's `RouterModule.register(...)` will **not** work
> here: it prefixes _controller_ routes, and `SkeinModule` serves from middleware. Drop the global
> prefix and the protocol serves from the root.

## License

[Apache-2.0](../../LICENSE)
