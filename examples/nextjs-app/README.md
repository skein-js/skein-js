# `nextjs-app` example

A **full-stack Next.js app**: the Agent Protocol is served **same-origin** from an App Router
catch-all route, and a [`useStream`](https://www.npmjs.com/package/@langchain/langgraph-sdk) chat UI
talks to it — one app, one process, **no CORS**. This is the flagship for
[`@skein-js/nextjs`](../../packages/server-nextjs) (the App Router half; see
[`nextjs-basic`](../nextjs-basic) for the Pages Router).

## The whole backend

```ts
// app/api/[...path]/route.ts
import { createSkeinRouteHandlers } from "@skein-js/nextjs";
import { deps } from "../../../lib/skein-deps";

export const runtime = "nodejs";
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createSkeinRouteHandlers({ deps });
```

The UI ([`app/page.tsx`](./app/page.tsx)) then points `useStream` at the relative `/api`:

```ts
const thread = useStream({ apiUrl: "/api", assistantId: "echo" });
```

Graphs are statically imported and passed via `{ deps }` (see [`lib/skein-deps.ts`](./lib/skein-deps.ts))
so Next bundles them for `next build` / `next start`.

## How to run

```bash
cp .env.local.example .env.local
pnpm install
pnpm dev                           # → next dev -p 2024
```

Open <http://localhost:2024> and chat with the zero-setup `echo` graph. Set
`NEXT_PUBLIC_SKEIN_ASSISTANT_ID=agent` (and `ANTHROPIC_API_KEY`) in `.env.local` to talk to the
Claude ReAct agent instead.

## Deployment caveat

The in-memory drivers + background run worker need a long-lived Node process (`next start`, Node
runtime). For serverless/edge, back skein with the Redis queue + Postgres store — see the
[adapter README](../../packages/server-nextjs/README.md#deployment-caveat).

## License

[Apache-2.0](../../LICENSE)
