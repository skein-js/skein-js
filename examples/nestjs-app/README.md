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

## How to run

```bash
cp .env.example .env          # only needed for the `agent` graph; `echo` needs nothing
pnpm install
pnpm dev                      # → tsx watch src/main.ts
```

- The app's REST: `http://127.0.0.1:2024/api/todos`
- The Agent Protocol: point a client at `http://127.0.0.1:2024` (root)

> **Tip:** to mount the protocol under a path instead of the root, wrap `SkeinModule` with Nest's
> `RouterModule.register([{ path: "agent", module: SkeinModule }])`.

## License

[Apache-2.0](../../LICENSE)
