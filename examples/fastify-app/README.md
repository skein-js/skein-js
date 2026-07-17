# `fastify-app` example

skein-js **embedded in an existing Fastify app**. The app keeps its own REST routes (`/health`,
`/api/todos`) and _also_ serves the Agent Protocol — mounted under `/agent` with `skeinPlugin`. The
plugin is encapsulated, so skein's routes and CORS stay isolated from the rest of your app.

```ts
import Fastify from "fastify";
import { skeinPlugin } from "@skein-js/fastify";

const app = Fastify();
app.get("/health", async () => ({ ok: true })); // your own routes
await app.register(skeinPlugin, { prefix: "/agent", config: "./langgraph.json" });
await app.listen({ port: 2024 });
```

See [`src/app.ts`](./src/app.ts). The same two graphs as [`fastify-basic`](../fastify-basic) are
served (`echo`, `agent`) — the only difference is _where_ they're mounted.

## How to run

```bash
cp .env.example .env          # only needed for the `agent` graph; `echo` needs nothing
pnpm install
pnpm dev                      # → tsx watch src/app.ts
```

- The app's REST: `http://127.0.0.1:2024/api/todos`
- The Agent Protocol: point a client at `http://127.0.0.1:2024/agent`

```ts
import { Client } from "@langchain/langgraph-sdk";
const client = new Client({ apiUrl: "http://127.0.0.1:2024/agent" });
```

## License

[Apache-2.0](../../LICENSE)
