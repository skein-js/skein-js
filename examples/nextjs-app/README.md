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

The UI ([`app/page.tsx`](./app/page.tsx)) then points `useStream` at the app's own `/api`. `useStream`
constructs `new URL(apiUrl)`, so give it an **absolute** same-origin URL (a bare `/api` throws
"Invalid URL"):

```ts
const apiUrl = `${window.location.origin}/api`; // same-origin, no CORS
const thread = useStream({ apiUrl, assistantId: "echo" });
```

Graphs are statically imported and passed via `{ deps }` (see [`lib/skein-deps.ts`](./lib/skein-deps.ts))
so Next bundles them for `next build` / `next start`.

## How to run

```bash
cp .env.local.example .env.local   # add your GOOGLE_API_KEY
pnpm install
pnpm dev                           # → next dev -p 2024
```

Open <http://localhost:2024> and chat — the UI is wired to the live Gemini `agent` graph (with a real
weather tool), so it needs `GOOGLE_API_KEY` set. Ask it something like _"what's the weather in
Nairobi?"_. (The zero-setup `echo` graph is still served over the API for the SDK/tests; this UI just
doesn't point at it.)

## Deployment caveat

The in-memory drivers + background run worker need a long-lived Node process (`next start`, Node
runtime). For serverless/edge, back skein with the Redis queue + Postgres store — see the
[adapter README](../../packages/server-nextjs/README.md#deployment-caveat).

## License

[Apache-2.0](../../LICENSE)
