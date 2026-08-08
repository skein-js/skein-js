# The skein console

> A web UI for a running skein server: assistants, threads, live runs, interrupts, time travel, the
> store, and crons. Served by the server itself, at `/console`.

## Contents

- [What it is](#what-it-is)
- [Running it](#running-it)
- [Turning it on in production](#turning-it-on-in-production)
- [What it shows](#what-it-shows)
- [Mounting it yourself](#mounting-it-yourself)
- [How it is built](#how-it-is-built)
- [Why not a hosted UI](#why-not-a-hosted-ui)

## What it is

The console is a **client**. It adds no endpoints and stores nothing of its own: every screen is built
from the Agent Protocol surface a skein server already exposes, driven through the real
[`@langchain/langgraph-sdk`](./react-sdk.md).

That is a deliberate constraint, not a coincidence. If a view cannot be built, it means the API is
missing something, and we would rather feel that here than paper over it with a bespoke endpoint. (One
gap found exactly this way: there is no cross-thread run search — runs list per thread — so "recent
activity" fans out over threads. See [roadmap](./roadmap.md).)

It ships as [`@skein-js/console`](../packages/console): the compiled UI plus a resolver, with **no
runtime dependencies**.

## Running it

`skein dev` serves it by default and prints the URL:

```
skein · Agent Protocol dev server

API      http://127.0.0.1:2024
Console  http://127.0.0.1:2024/console/
Docs     https://github.com/skein-js/skein-js/tree/main/docs
```

Pass `--no-console` to leave it out.

Because it is served by the server, it is **same origin**: no CORS to configure, no second process, no
account, and it works with no internet connection.

## Turning it on in production

**Off by default** under `skein start` and the production image. The console can read and delete every
thread, memory and schedule on the server, so enabling it is a decision you make:

```jsonc
{
  "http": {
    "console": true, // serve at /console
    // or: "console": "/admin/console"  — any path but "/"
  },
}
```

Requests from the console go through the **same** [`auth`](./agent-protocol.md#authentication--authorization)
path as any other client; there is no bypass. On a server with custom auth, use the console's
connection control (top right) to supply an API key — it is sent as `x-api-key` and held in
`localStorage`, since a static bundle has no server of its own to set a cookie.

Two things worth knowing before you enable it on a public host:

- The **assets** are served unauthenticated (they are a UI shell; every byte of data behind them is
  authorized). If that is not acceptable, put the mount path behind your ingress' own auth.
- `http.console` is honoured by the **Express** transport, which is `skein start`'s Node runtime. On
  Bun/Deno the flag logs a warning and does nothing — mount it yourself (below).

## What it shows

| View            | What it is for                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Playground**  | Pick a graph and run it: a chat transcript for graphs with a `messages` channel, a JSON editor for everything else. Streams live, and surfaces interrupts inline. This is the landing page. |
| **Overview**    | **Waiting for you** (threads parked on `interrupt()`, linking straight to the filtered list), counts, recent threads, and the `GET /info` capability handshake.                             |
| **Assistants**  | Every registered graph, its schemas, its graph shape, its version history.                                                                                                                  |
| **Threads**     | Filter by status (`#/threads?status=interrupted` is a shareable link); per thread: state, runs, checkpoints, and pending interrupts.                                                        |
| **Runs**        | Live SSE tail, cancel, rollback, delete. Works on finished runs too — the server replays what it persisted.                                                                                 |
| **Interrupts**  | The "Waiting for you" panel: approve, reject, or resume with any JSON value.                                                                                                                |
| **Time travel** | Open a past checkpoint, edit its state, fork it, and run forward from the fork.                                                                                                             |
| **Store**       | Namespace tree (prefix/suffix/depth), item search with a `filter` and semantic `query`, delete.                                                                                             |
| **Crons**       | Schedules with their next occurrence, pause/resume, create, delete.                                                                                                                         |

Opening the console lands on the **playground**, because the first question anyone has about a server
is whether their graph works; everything else answers a question you only have later.

Routing is on the URL **hash** (`#/threads/abc`), so deep links never reach the server and the console
needs no SPA history fallback on any adapter.

> **A note on editing state at a checkpoint:** values you write go through the graph's _reducers_. A
> channel that appends (a message list, say) will add what you write rather than replace it. The
> console says so inline, because this surprises everyone once.

## Mounting it yourself

The console is route bindings and bytes, so any adapter can serve it. It is not a dependency of the
adapters on purpose — the compiled UI is ~670 kB, and mounting the protocol should not cost that.

```ts
import { consoleAssetHeaders, resolveConsoleRequest } from "@skein-js/console";

// Express, Fastify, Hono, a Fetch handler — the shape is the same.
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const resolution = resolveConsoleRequest(req.path, { mountPath: "/console" });
  if (resolution.kind === "miss") return next();
  if (resolution.kind === "redirect") return res.redirect(302, resolution.location);
  res.set(consoleAssetHeaders(resolution.asset));
  return res.status(200).send(Buffer.from(resolution.asset.bytes));
});
```

Two rules the resolver enforces so you do not have to:

- **A bare mount path redirects to its slashed form.** Assets are referenced relatively (so one build
  works at any mount point); at `/console` the browser would resolve them against the parent directory.
- **An unknown path is a `miss`, not a fallback to `index.html`.** Hash routing means a real deep link
  never arrives, so answering 200-with-HTML would only turn a broken asset reference into a blank page.

The SPA derives the API base by dropping the **last segment** of its own path: `/console/` → `/`,
`/api/console/` → `/api`. Mount it at `<api-base>/console` and it finds the server with no
configuration. To point it somewhere else entirely, append `?baseUrl=https://your-deployment` (the
choice is remembered), which is also how you would host the bundle statically.

## How it is built

The UI is a static Vite + React SPA ([shadcn/ui](https://ui.shadcn.com), light/dark with a
system-aware toggle), built by the `console-ui` Nx project. `nx serve console-ui` is the HMR dev loop.

`nx build console` then chains: build the SPA → compile its files into `src/assets.generated.ts` as
string constants → bundle. That last step is why the package can be a _library_: skein forbids reading
package-relative files at runtime, because bundlers rewrite `import.meta.url` to the output location
(see [bundling.md](./bundling.md)). `@skein-js/storage-postgres` solved the same problem for its SQL;
the console does it for HTML, JS and CSS. A test pins the total size so the CLI's install cost cannot
drift upward unnoticed.

## Why not a hosted UI

LangGraph ships no UI in its CLI or server: `langgraph dev` prints a link to Studio, a web app on
LangChain's domain that talks to your local server from the browser. That buys instant updates and zero
install size, and costs an account, an internet connection, permissive CORS, and a Cloudflare tunnel
(`--tunnel`) for the browsers that refuse `https` → `http://localhost`.

Serving from the server inverts every one of those: no CORS, no tunnel, no mixed content, no account,
works air-gapped, inherits your `Auth` instead of needing a bypass header, and the console can never
drift from the protocol version of the server it is talking to. The costs are real too — install size,
and a release to update it — which is why the size budget exists.
