# Building your own adapter

skein-js ships adapters for [Express](../packages/server-express),
[Fastify](../packages/server-fastify), [NestJS](../packages/server-nestjs), and
[Next.js](../packages/server-nextjs) (App + Pages Router). If your stack isn't one of those — a raw
Node `http` server, [Hono](https://hono.dev), Koa, an existing app on some other framework — you can
write your own adapter in a few dozen lines. This guide shows how; the four shipped adapters are all
built exactly this way.

## Contents

- [Why this is easy](#why-this-is-easy)
- [The contract](#the-contract)
- [Step 1 — assemble a runtime](#step-1--assemble-a-runtime)
- [Step 2 — the route table](#step-2--the-route-table)
- [Step 3 — map your request onto `ProtocolRequest`](#step-3--map-your-request-onto-protocolrequest)
- [Step 4 — serialize the `ProtocolResponse`](#step-4--serialize-the-protocolresponse)
- [Step 5 — handle errors](#step-5--handle-errors)
- [Step 6 — worker lifecycle & CORS](#step-6--worker-lifecycle--cors)
- [A complete minimal adapter](#a-complete-minimal-adapter)
- [Checklist](#checklist)

## Why this is easy

All of skein-js's protocol logic lives in [`@skein-js/agent-protocol`](../packages/agent-protocol)
behind a **transport-neutral handler table**. An adapter adds _no protocol logic_ — it only does
shape translation: turn your framework's request into a normalized `ProtocolRequest`, call the right
handler, and write the returned `ProtocolResponse` back out. The shipped
[Express adapter](../packages/server-express) is exactly this and nothing more; yours will mirror it.

```text
your framework request ──▶ ProtocolRequest ──▶ handler ──▶ ProtocolResponse ──▶ your framework response
        (Step 3)                                (Step 2)         (Step 4)
```

## The contract

Three types from `@skein-js/agent-protocol` are all you touch:

```ts
interface ProtocolRequest {
  method: string; // "POST"
  url: string; // absolute URL (path + query) — an auth handler may read it
  params: Record<string, string>; // path params, e.g. { thread_id }
  query: Record<string, string | string[] | undefined>;
  body: unknown; // parsed JSON body
  headers: Record<string, string | undefined>; // lowercased names
}

type ProtocolResponse =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "empty"; status: number }
  | { kind: "sse"; status: number; events: AsyncIterable<string> };

type ProtocolHandler = (req: ProtocolRequest) => Promise<ProtocolResponse>;
```

`ProtocolHandlers` is a table of named handlers (`createThread`, `createStreamRun`, `joinRunStream`,
`putStoreItem`, …). Each validates the request (with Zod), calls the typed service, and returns a
`ProtocolResponse`. You dispatch to them by name.

## Step 1 — assemble a runtime

Build a `ProtocolRuntime` from a `ProtocolDeps` (the injected storage/queue/graph bundle). The
easiest way to get production `deps` from a `langgraph.json` is
[`@skein-js/runtime`](../packages/runtime)'s `buildRuntime`:

```ts
import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { buildRuntime } from "@skein-js/runtime";

const { deps } = await buildRuntime({
  configPath: "./langgraph.json",
  store: "memory", // or "postgres"
  queue: "memory", // or "redis"
});

const runtime = createProtocolRuntime(deps);
await runtime.service.assistants.registerGraphAssistants(); // seed one assistant per graph
runtime.worker.start(); // start the background run worker
// runtime.handlers is your ProtocolHandlers table
```

> You can also construct `deps` by hand (your own `SkeinStore`, `RunQueue`, `RunEventBus`, and a
> `GraphResolver`) — see [`@skein-js/core`](../packages/core) for the interfaces and
> [storage.md](./storage.md) / [runs-and-redis.md](./runs-and-redis.md) for the drivers.

## Step 2 — the route table

The paths mirror the `@langchain/langgraph-sdk` client exactly (that's the conformance oracle — don't
invent your own spelling). Bind each `method + path` to a handler name. The canonical table is
exported from `@skein-js/agent-protocol` as `skeinRoutes` (re-exported from `@skein-js/express` too,
for back-compat):

```ts
import { skeinRoutes, copyThreadIdIntoBody, matchSkeinRoute } from "@skein-js/agent-protocol";
// skeinRoutes: { method, path, handler, foldThreadIdIntoBody? }[]
// e.g. { method: "post", path: "/threads/:thread_id/runs/stream",
//        handler: "createStreamRun", foldThreadIdIntoBody: true }
//
// copyThreadIdIntoBody(request)              — the body-fold rule for foldThreadIdIntoBody routes
// matchSkeinRoute(method, pathname)  — match a catch-all path → { binding, params }
//   (handy for adapters that dispatch from one route, like the NestJS + Next.js adapters)
```

Three things to get right:

- **Order most-specific first** within each method so literals win over params (e.g.
  `/threads/search` before `/threads/:thread_id`).
- **`foldThreadIdIntoBody`** — the SDK addresses a thread-scoped run by its path
  (`POST /threads/{id}/runs/stream`) but the stateless run handlers read `thread_id` from the body.
  For those routes, copy the path `thread_id` into the body before dispatch (see the worked example).
- **Strip your mount prefix before matching.** `skeinRoutes` paths are anchored at the protocol root,
  so if your adapter mounts a **catch-all** and matches by hand, the framework hands it the full
  external path (`/api/threads`) which will never match `^/threads$`. Use `stripBasePath` from
  `@skein-js/server-kit`, and treat its `null` as "not ours" — pass the request through untouched so
  the host app's own routes still resolve:

  ```ts
  import { stripBasePath } from "@skein-js/server-kit";

  const pathname = stripBasePath(url.pathname, mountPrefix);
  if (pathname === null) return next(); // not under our mount — the host app's problem
  const match = matchSkeinRoute(method, pathname);
  ```

  Adapters that mount each route **explicitly** (Express's `Router`, Fastify's plugin `prefix`) get
  this from their router for free and can skip it. Where `mountPrefix` comes from is
  framework-specific: the NestJS adapter reads Nest's own `app.setGlobalPrefix(...)` via
  `ApplicationConfig`, while the Next.js adapters take an explicit `basePath` option.

## Step 3 — map your request onto `ProtocolRequest`

Pure shape translation. Header names must be **lowercased** (handlers look up `last-event-id`), and
array-valued headers flattened to a single value:

```ts
function toProtocolRequest(req /* your framework request */, params): ProtocolRequest {
  return {
    method: req.method,
    url: absoluteUrl(req), // e.g. `http://${host}${originalUrl}` — must include the query string
    params, // from your router match, e.g. { thread_id }
    query: parsedQuery(req),
    body: parsedJsonBody(req),
    headers: lowercasedSingleValueHeaders(req),
  };
}
```

If you're on Express specifically, `@skein-js/express` exports `toProtocolRequest` so you don't have
to write this.

## Step 4 — serialize the `ProtocolResponse`

Switch on `response.kind`:

- **`json`** — **serialize with `serializeWireJson` from `@skein-js/core`, not your framework's
  `res.json`.** Bodies may contain LangChain messages (thread state, history, `runs.wait` values)
  that must be flattened to the wire shape clients expect. Send with
  `Content-Type: application/json`.
- **`empty`** — just write the status and end.
- **`sse`** — set the SSE headers (`SSE_HEADERS`), flush them, then write each string from
  `response.events` as-is. **Do not re-encode** — the core already produced complete frames (each
  ends in `\n\n`). When the client disconnects, call the iterator's `return()` so the run's frame
  subscription is torn down.

```ts
import { SSE_HEADERS } from "@skein-js/agent-protocol";
import { serializeWireJson } from "@skein-js/core";

async function send(response, res) {
  if (response.kind === "json") {
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(serializeWireJson(response.body));
    return;
  }
  if (response.kind === "empty") {
    res.writeHead(response.status).end();
    return;
  }
  // sse
  res.writeHead(response.status, SSE_HEADERS);
  const iterator = response.events[Symbol.asyncIterator]();
  res.on("close", () => void iterator.return?.(undefined)); // release the frame source on hangup
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    res.write(next.value);
  }
  if (!res.writableEnded) res.end();
}
```

## Step 5 — handle errors

Handlers throw `SkeinHttpError` for client-visible faults (it carries the intended `status`,
`message`, and optional `code`/`details`). Anything else is an unexpected `500`. Once SSE headers are
flushed you can no longer set a status — just end the stream.

```ts
import { isSkeinHttpError } from "@skein-js/core";

function sendError(error, res, logger) {
  if (res.headersSent) {
    if (!isSkeinHttpError(error)) logger?.error("Error after headers sent.", error);
    if (!res.writableEnded) res.end();
    return;
  }
  if (isSkeinHttpError(error)) {
    res.writeHead(error.status, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: error.status,
        message: error.message,
        ...(error.code !== undefined ? { code: error.code } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      }),
    );
    return;
  }
  logger?.error("Unhandled error.", error);
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: 500, message: "Internal Server Error" }));
}
```

## Step 6 — worker lifecycle & CORS

- **Worker** — `runtime.worker.start()` drains the run queue (background runs). Call
  `runtime.worker.stop()` on shutdown so in-flight runs drain cleanly.
- **CORS** — browser clients (Agent Chat UI, React `useStream`) run on a different origin than your
  server, so you must send `Access-Control-Allow-*` headers (and answer preflight `OPTIONS`) on every
  route, including the SSE streams. [`@skein-js/server-kit`](../packages/server-kit) exports
  `corsFromHttpConfig` / `toCorsOptions` (the shared, framework-agnostic home; also re-exported from
  `@skein-js/express`) to derive `cors`-style options from the `langgraph.json` `http.cors` block; on
  another framework, apply the equivalent middleware.

> **Shortcut:** [`@skein-js/server-kit`](../packages/server-kit)'s `resolveProtocolRuntime(options)`
> does Steps 1 + the worker lifecycle in one call — resolve `{ config } | { deps }` into a running
> runtime (assistants seeded, worker started) plus any CORS from the config. It's what the Express,
> Fastify, NestJS, and Next.js adapters all use.

## A complete minimal adapter

A dependency-free adapter over Node's built-in `http` server — no Express, no framework:

```ts
import { createServer } from "node:http";

import { createProtocolRuntime, skeinRoutes, SSE_HEADERS } from "@skein-js/agent-protocol";
import { isSkeinHttpError, serializeWireJson } from "@skein-js/core";
import { buildRuntime } from "@skein-js/runtime";

const { deps } = await buildRuntime({
  configPath: "./langgraph.json",
  store: "memory",
  queue: "memory",
});
const runtime = createProtocolRuntime(deps);
await runtime.service.assistants.registerGraphAssistants();
runtime.worker.start();

// Compile the SDK route patterns to matchers once.
const routes = skeinRoutes.map((r) => ({
  ...r,
  regex: new RegExp("^" + r.path.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"),
}));

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const match = routes.find(
      (r) => r.method === req.method?.toLowerCase() && r.regex.test(url.pathname),
    );
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const params = match.regex.exec(url.pathname)?.groups ?? {};

    const body = await readJson(req); // parse the JSON body (omitted for brevity)
    let protocolRequest = {
      method: req.method,
      url: url.href,
      params,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: req.headers, // already lowercased by Node
    };
    // Thread-scoped run routes: fold the path thread_id into the body.
    if (match.foldThreadIdIntoBody && params.thread_id) {
      protocolRequest = {
        ...protocolRequest,
        body: { ...(body ?? {}), thread_id: params.thread_id },
      };
    }

    const response = await runtime.handlers[match.handler](protocolRequest);

    if (response.kind === "json") {
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(serializeWireJson(response.body));
    } else if (response.kind === "empty") {
      res.writeHead(response.status).end();
    } else {
      res.writeHead(response.status, SSE_HEADERS);
      const it = response.events[Symbol.asyncIterator]();
      res.on("close", () => void it.return?.(undefined));
      for (let n = await it.next(); !n.done; n = await it.next()) res.write(n.value);
      if (!res.writableEnded) res.end();
    }
  } catch (error) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
    } else if (isSkeinHttpError(error)) {
      res.writeHead(error.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: error.status, message: error.message }));
    } else {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: 500, message: "Internal Server Error" }));
    }
  }
});

server.listen(2024);
// On shutdown: await runtime.worker.stop(); server.close();
```

Point the official SDK at `http://localhost:2024` and it just works — because the wire format is
produced by the same handler table the Express adapter uses.

## Checklist

- [ ] Assembled a `ProtocolRuntime`; called `registerGraphAssistants()` and `worker.start()`.
- [ ] Bound every route in `skeinRoutes`, most-specific-first, with `foldThreadIdIntoBody` honored.
- [ ] `ProtocolRequest` has lowercased single-value headers and an absolute `url` (with query).
- [ ] JSON responses serialized with `serializeWireJson` (not a plain `JSON.stringify`/`res.json`).
- [ ] SSE responses stream frames unmodified, set `SSE_HEADERS`, and tear down on client close.
- [ ] `SkeinHttpError` mapped to its status; everything else → `500`; no status changes mid-stream.
- [ ] CORS applied for browser clients; `worker.stop()` on shutdown.
- [ ] Verified with the real `@langchain/langgraph-sdk` client (see [testing.md](./testing.md)).

Reference implementation: [`@skein-js/express`](../packages/server-express) —
[`routes.ts`](../packages/server-express/src/routes.ts),
[`to-protocol-request.ts`](../packages/server-express/src/to-protocol-request.ts),
[`send-protocol-response.ts`](../packages/server-express/src/send-protocol-response.ts),
[`error-response.ts`](../packages/server-express/src/error-response.ts).

Built an adapter for a framework we don't ship? We'd love a PR — see
[CONTRIBUTING.md](../CONTRIBUTING.md).
