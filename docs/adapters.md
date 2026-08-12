# Framework adapters

An adapter is a thin transport shim: it takes the framework-agnostic handler table from
`@skein-js/agent-protocol` and puts it on Express, Fastify, NestJS, Next.js, or the Web Fetch API.
The engine, the endpoints and the wire format are identical on all five — what differs is how you
mount it, and a handful of host-framework details this page exists to spell out.

Every adapter takes the **same options bag**: `{ config }` to build a runtime from a
`langgraph.json`, or `{ deps }` to bring [your own assembled `ProtocolDeps`](./embedding.md). That
seam is the whole API. Picking a different adapter changes neither.

## Pick one

Each adapter has a **standalone** entry — a dedicated agent server — and an **embed** entry that
mounts the protocol inside an app you already run:

| Adapter             | Standalone               | Mount into your app                        | Example                                                                                                                                                                     |
| ------------------- | ------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@skein-js/express` | `createExpressServer`    | `skeinRouter` → `app.use()`                | [express-basic](https://github.com/skein-js/skein-js/tree/main/examples/express-basic)                                                                                      |
| `@skein-js/fastify` | `createFastifyServer`    | `skeinPlugin` under a `prefix`             | [fastify-basic](https://github.com/skein-js/skein-js/tree/main/examples/fastify-basic) · [fastify-app](https://github.com/skein-js/skein-js/tree/main/examples/fastify-app) |
| `@skein-js/nestjs`  | `createNestServer`       | `SkeinModule.forRoot()`                    | [nestjs-basic](https://github.com/skein-js/skein-js/tree/main/examples/nestjs-basic) · [nestjs-app](https://github.com/skein-js/skein-js/tree/main/examples/nestjs-app)     |
| `@skein-js/nextjs`  | — (the routes _are_ it)  | `createSkeinRouteHandlers` / Pages handler | [nextjs-app](https://github.com/skein-js/skein-js/tree/main/examples/nextjs-app) · [nextjs-basic](https://github.com/skein-js/skein-js/tree/main/examples/nextjs-basic)     |
| `@skein-js/fetch`   | `createSkeinFetchServer` | — (no mount export)                        | — (covered by CI's runtime matrix)                                                                                                                                          |

Express is the default: it is what `skein dev` and the production image run, and what the other
docs use in examples. Reach for another when you already have an app on it.

## What is identical everywhere

The full endpoint surface (`/threads`, `/assistants`, `/runs`, `/store`, `/crons`), SSE streaming
with the same frames, human-in-the-loop, auth, and every client — `useStream`, Agent Chat UI, the
LangGraph SDK — work against any of them with only a URL change. A `ProtocolDeps` you assembled for
one adapter mounts on any other unchanged.

## What differs

This is the part worth reading before you pick:

|                    | Express                     | Fastify                        | NestJS                                | Next.js                     | Fetch                              |
| ------------------ | --------------------------- | ------------------------------ | ------------------------------------- | --------------------------- | ---------------------------------- |
| **Mount path**     | `app.use("/agent", …)`      | `register({ prefix })`         | `app.setGlobalPrefix()` only          | `basePath` (default `/api`) | `basePath` (default `""`)          |
| **CORS**           | bundled `cors` package      | optional peer `@fastify/cors`  | skein's middleware, skein routes only | built in                    | built in                           |
| **JSON body cap**  | 100 kb, via `json.limit`    | Fastify's `bodyLimit` (1 MB)   | the host's parser, else unbounded     | unbounded                   | 100 kb, via `maxBodyBytes`         |
| **Logger default** | none — stays silent         | `fastify.log` (pino)           | Nest's `Logger`                       | none — stays silent         | none — stays silent                |
| **`/ok` route**    | standalone only             | standalone only                | standalone only                       | **never**                   | always                             |
| **Shutdown**       | `close()` drains the worker | `close()`, or plugin `onClose` | needs `enableShutdownHooks()`         | **none** — nothing drains   | `close()` after the listener stops |

Two of these bite most often. **The body cap is not uniform** — only Express and Fetch impose one of
their own, so on NestJS with `bodyParser: false`, and on Next.js, a large body is read into memory
before auth runs. And **only Express and Fetch drain cleanly by default**: a Next.js deploy has no
shutdown path at all, because the runtime lives on `globalThis` for the life of the process.

## Express

The default, and the reference implementation every other adapter is checked against.

```ts
import { createExpressServer, skeinRouter } from "@skein-js/express";

// Standalone — a dedicated agent server with a /ok probe:
const server = await createExpressServer({ config: "./langgraph.json" });
await server.listen(2024);

// Or mounted on an app you already run. `skeinRouter` is async — it seeds assistants
// and starts the run worker before returning, so the router is ready to serve:
const { router } = await skeinRouter({ deps });
app.use("/agent", router);
```

Express strips the mount path for you, so nothing needs to be kept in sync. Two options no other
adapter has: `json.limit` (default 100 kb — a limit the parser can't understand is rejected at mount
time rather than silently becoming unlimited) and `requestLog`.

**It logs nothing by default.** Express owns no logger, and a library shouldn't decide to start
writing to its host's stdout — pass `createConsoleLogger()` if you want output.

## Fastify

```ts
import { createFastifyServer, skeinPlugin } from "@skein-js/fastify";

// Standalone:
const server = await createFastifyServer({ config: "./langgraph.json" });
await server.listen(2024);

// Embedded — encapsulated, so skein's hooks don't leak into your app:
await app.register(skeinPlugin, { prefix: "/agent", config: "./langgraph.json" });
```

Three things to know. **CORS needs an optional peer**: `@fastify/cors` is imported lazily and only
when CORS is on, so enabling it without installing the package throws at registration rather than
failing a request later. The plugin **replaces the JSON content-type parser** so an empty body sent
with `Content-Type: application/json` is read as `{}` — Fastify's default parser 400s on it where
Express does not, and the adapters have to agree. And SSE **hijacks the reply** and writes to the raw
socket, which is why a client disconnect is detected there rather than on the request.

There is no `json.limit`; Fastify's own `bodyLimit` applies.

> [!WARNING]
> **`createFastifyServer` ignores `http.disable_*`.** The standalone server does not forward the
> route table that a `langgraph.json`'s disable flags produce, so it mounts the full protocol
> surface even when the config asks for less. `skeinPlugin` honours them correctly, as do the other
> four adapters. This is a bug, not a design choice — until it is fixed, use the plugin if you rely
> on those flags.

## NestJS

```ts
import { SkeinModule } from "@skein-js/nestjs";

@Module({ imports: [SkeinModule.forRoot({ config: "./langgraph.json" })] })
export class AppModule {}
```

NestJS is the odd one out on mounting: it reads its prefix from the framework via
`app.setGlobalPrefix()` rather than from an argument you pass, so there is no skein-side option that
can drift out of sync — but also no way to mount it somewhere else.

Three consequences that look like bugs and aren't:

- **`GET /api` 404s**, and so does `/info`. Nest never routes the bare prefix root to middleware, and
  no skein route lives at `/`.
- **`SkeinModule` registers no `/ok`.** Only `createNestServer` does. Point health checks at a route
  you own, or use the standalone server.
- **A log line about an unsupported route path** during boot is harmless.

**Call `app.enableShutdownHooks()`** when embedding. skein stops the run worker on
`beforeApplicationShutdown` so in-flight SSE streams settle before the server closes, and without the
hooks that never fires. The standalone server does it for you.

CORS is applied by skein's own middleware, scoped to skein's routes, so it behaves identically
standalone and embedded — `app.enableCors()` governs your routes, not these.

## Next.js

There is no standalone entry: the route handlers **are** the server, same-origin with your UI.

```ts
// app/api/[...path]/route.ts — App Router
import { createSkeinRouteHandlers } from "@skein-js/nextjs";

export const runtime = "nodejs"; // the run worker needs a long-lived process, not the edge
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createSkeinRouteHandlers({ deps });
```

```ts
// pages/api/[...path].ts — Pages Router
import { createSkeinPagesHandler } from "@skein-js/nextjs";

// externalResolver tells Next this route settles the response itself, which silences the
// "API resolved without sending a response" warning that SSE streams otherwise trigger.
export const config = { api: { bodyParser: true, externalResolver: true } };
export default createSkeinPagesHandler({ deps });
```

`basePath` defaults to `/api` and must match where you put the catch-all. The runtime is memoized on
`globalThis`, keyed by config path or `deps` identity, so two route files sharing a config share one
runtime — which is why a handler's own `logger` option outranks the shared runtime's, rather than
whichever handler served the first request deciding for both.

**This needs a warm process.** The in-memory drivers and the background run worker don't survive a
function that scales to zero — a serverless deploy needs the Postgres store and Redis queue. See
[deploy-serverless.md](./deploy-serverless.md).

## Fetch (Bun / Deno)

The web-standard transport, and the production path on Bun and Deno. `skein build --runtime bun|deno`
selects it for you.

```ts
import { createSkeinFetchServer, startBunServer } from "@skein-js/fetch";

const skein = await createSkeinFetchServer({ config: "./langgraph.json" });
const listener = startBunServer(skein, { port: 2024 });

// Stop accepting connections first, then drain:
await listener.stop();
await skein.close();
```

It is the only adapter that caps request bodies itself — `maxBodyBytes`, default 100 kb — and it has
to: `Bun.serve` defaults to 128 MB and `Deno.serve` has no limit at all, and the body is read before
auth runs, so an unbounded read is an unauthenticated way to exhaust memory.

`/ok` is always served, `basePath` defaults to `""`, and there is **no mount export and no invoke
surface** — the handler is a whole-server `fetch` function. Composing it into a host router is yours
to do.

## What you must get right

- **`skeinRouter` is async.** `skeinRouter({ deps }).router` is `undefined`; await it first. It seeds
  assistants and starts the run worker before returning.
- **Auth handlers that match on a path are not portable between adapters.** Express and NestJS report
  the full mount-inclusive URL, while Next.js and Fetch report it with the mount prefix stripped — so
  a handler matching `/threads` sees that on one and `/api/threads` on another. Match on the
  protocol-relative suffix, or keep the handler adapter-specific.
- **Auth is off by default on the `{ deps }` path**, whichever adapter you mount it on. See the
  warning in [embedding.md](./embedding.md).
- **Only the standalone servers add `/ok`** — except Next.js, which never does, and Fetch, which
  always does. Check the table above before pointing a platform health check at it.
- **No adapter serves the console.** `http.console` is honoured by `skein start`'s Node runtime,
  which mounts it for you; on Bun/Deno the flag warns and does nothing. Mount it into your own app
  yourself, whichever adapter you are on — see [console.md](./console.md#mounting-it-yourself).

## See also

- [Using skein-js](./using-skein.md) — the terse cheat-sheet version of this page
- [Embedding a graph](./embedding.md) — the `{ deps }` seam every adapter accepts
- [Errors & logging](./errors-and-logging.md#what-each-adapter-does-by-default) — logger defaults in full
- [A graph as a plain endpoint](./serving-a-single-graph.md) — the invoke surface, per adapter
- [Building an adapter](./building-an-adapter.md) — putting the handler table on a framework we don't ship
