# Console setup reference

Configure how the console connects to your server, enable it in production, or mount it inside your
own application. For running and inspecting your graph, start with the [console guide](./console.md).

## Connect to a server

`skein dev` serves the console by default. Pass `--no-console` to disable it. Use the connection
control in the top right to check the selected server and enter an API key. Keys are sent as
`x-api-key`, saved in this browser's `localStorage`, and bound to the server where you entered them.
Changing the connection or key resets this tab's drafts and navigation workspace. Drafts otherwise
last for the browser tab's lifetime; they are not a backup of your project.

Account changes outside the console's connection control are not detected automatically. If you
switch users through your application's sign-in flow, close the console tab and open it afresh to
clear its drafts. If browser storage is unavailable, the console warns that drafts may not survive
a reload.

The default mount is same-origin, so it needs no separate CORS configuration. For another server,
use `?baseUrl=https://your-deployment`; the choice is remembered. Check the destination before
confirming a foreign-server connection. Cross-origin servers must allow the console's origin in
[their CORS policy](./recipes/serving.md#cors-for-a-browser-client).

## Development authentication

With custom auth, run `skein dev --dev-ui-access` or enable it in `langgraph.json`:

```jsonc
{
  "auth": {
    "path": "./src/auth.ts:auth",
    "dev_ui_access": true, // skein dev only; stripped from production builds
  },
}
```

Both forms print a temporary API key shared by the console and LangGraph Studio. Enter it in the
console's connection control or add `x-api-key` under Studio's **Custom Headers**. The key skips your
custom `authenticate` callback; your `@auth.on.*` authorization callbacks still run with the
`skein-dev-ui-user` identity. It rotates every 15 minutes, with a one-minute grace period for the
previous key. The new key appears in the server output; enter it again in each UI. It works only when
the dev server binds to loopback (`127.0.0.1`, `::1`, or `localhost`). Without either opt-in, both
UIs need normal credentials. Dev UI access allows Studio's `https://smith.langchain.com` origin when
no `http.cors` policy is configured; an explicit policy must allow that origin itself. Keep the
printed key private; anyone holding it can call the API as that dev identity.

## Turning it on in production

**Off by default** under `skein start` and the production image. The console can read and change
resources allowed by your server's authorization policy:

```jsonc
{
  "http": {
    "console": true, // serve at /console
    // or: "console": "/admin/console"  — any path but "/"
  },
}
```

Requests from the console go through the **same** [`auth`](./agent-protocol.md#authentication--authorization)
path as any other client. The temporary UI key is unavailable under `skein start`. On a server with
custom auth, use the console's connection control (top right) to supply an API key — it is sent as
`x-api-key` and held in
`localStorage`, since a static bundle has no server of its own to set a cookie.

Two things worth knowing before you enable it on a public host:

- The **assets** are served unauthenticated (they are a UI shell; every byte of data behind them is
  authorized). If that is not acceptable, put the mount path behind your ingress' own auth.
- `http.console` is honoured by the **Express** transport, which is `skein start`'s Node runtime. On
  Bun/Deno the flag logs a warning and does nothing — mount it yourself (below).

## Advanced run options

Open **Advanced run options** in Playground when a test needs something beyond the current thread.

| Option               | When to use it                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Existing thread      | Continue a conversation using its exact ID                                                               |
| Stateless run        | Let the server create a thread for this execution; choose completion retention                           |
| Batch                | Submit 1–100 JSON objects for the selected Assistant                                                     |
| Delay                | Start later; the value is in seconds                                                                     |
| Busy-thread strategy | Reject, enqueue, interrupt, or roll back when another run is active                                      |
| Execution timeout    | Set integer milliseconds, within the deployment limit; available only when the server advertises support |
| Idempotency key      | Protect a repeated submission from creating another run                                                  |
| Stream modes         | Choose the output captured while observing the run                                                       |

See [run modes and options](./runs.md) for the public contracts. Delayed and keyed submissions run in
the background. Closing observation leaves execution running. After an ambiguous failure, inspect
the thread before retrying. A failed batch may already have created some runs.

## Resource changes

The console uses the server's authorization for every operation. Inspecting a resource does not
make changes such as deletion or replay safe to repeat.

- **Assistants:** deletion keeps threads by default; cascading deletion is explicit. A default
  Assistant registered from graph configuration returns at startup. Deleting it does not remove
  the graph from `langgraph.json`.
- **Threads:** copy, prune checkpoints, set retention, or delete. Retention is in minutes;
  `null` means no expiry, while missing readback means unavailable. Expiry makes a thread eligible
  for cleanup; active work may defer cleanup. See [thread retention](./threads.md#expiring-threads-automatically).
- **Store:** saving replaces the value at the same namespace/key and resets expiry using the chosen
  lifetime or deployment default. Browsing requests non-refreshing reads. If a custom adapter cannot
  support them, **Load using normal reads** may extend sliding expiry. See [store TTL](./storage.md#store-item-ttl).
- **Schedules:** use five-field cron and the selected timezone. Editing scheduling fields preserves
  the saved run input and Assistant configuration. An enabled schedule with no future occurrence
  shows **no upcoming run**. See [schedules](./crons.md).
- **Deliveries:** dead deliveries can be replayed. Delivery is at least once, so receivers must
  deduplicate by the stable delivery ID. See [webhook receivers](./webhooks.md).
- **Channels:** inventory is read-only. Edit code or `langgraph.json` and restart to change routes.
  The screen is available only when channels are configured. See [channels](./channels.md).

## Inspection limits

Lists are paged and refresh on demand. Overview samples recent threads. Run details retain a bounded
buffer of events and report dropped history; use your logs or tracing backend for a durable diagnostic
record. Execution status and observer connection status are separate. Closing an observer never
cancels a run; choose **Stop run** to request cancellation.

Thread and run inspection tabs can be shared through their hash URLs. A fresh Playground link uses
`#/playground?new=1`, optionally with `assistant=<id>`; `#/playground/<threadId>` continues that thread.

## Mounting it yourself

Install `@skein-js/console` in your server project and serve it alongside the protocol. Framework
adapters do not mount the console automatically. For an Express application:

```ts
import { consoleAssetHeaders, resolveConsoleRequest } from "@skein-js/console";

// app is your Express application; register before a catch-all route.
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
