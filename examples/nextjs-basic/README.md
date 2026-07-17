# `nextjs-basic` example

skein-js served from a **Next.js Pages Router** catch-all API route — headless (no UI), the smallest
way to serve the Agent Protocol from an existing Next app. Demonstrates the **Pages Router** half of
[`@skein-js/nextjs`](../../packages/server-nextjs) (the [`nextjs-app`](../nextjs-app) example shows
the App Router + a chat UI).

## The whole API

```ts
// pages/api/[...path].ts
import { createSkeinPagesHandler } from "@skein-js/nextjs";
import { deps } from "../../lib/skein-deps";

export const config = { api: { bodyParser: true, externalResolver: true } };
export default createSkeinPagesHandler({ deps });
```

Graphs are **statically imported** and passed via the `{ deps }` seam (see
[`lib/skein-deps.ts`](./lib/skein-deps.ts)) — Next bundles them, so this works under `next build` /
`next start` (a `.ts` graph can't be dynamically `import()`ed at runtime in a Next server).

| Graph id | Needs a key?           |
| -------- | ---------------------- |
| `echo`   | ❌ no                  |
| `agent`  | ✅ `ANTHROPIC_API_KEY` |

## How to run

```bash
cp .env.local.example .env.local   # only for the `agent` graph
pnpm install
pnpm dev                           # → next dev -p 2024
```

Then talk to it at `http://localhost:2024/api`:

```ts
import { Client } from "@langchain/langgraph-sdk";
const client = new Client({ apiUrl: "http://localhost:2024/api" });
```

## Deployment caveat

The in-memory drivers and the background run worker need a long-lived Node process (`next start` with
the default Node runtime). For serverless/edge, back skein with the Redis queue + Postgres store — see
the [adapter README](../../packages/server-nextjs/README.md#deployment-caveat).

## License

[Apache-2.0](../../LICENSE)
