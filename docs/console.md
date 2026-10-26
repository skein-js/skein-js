# The skein console

> A web UI for a running skein server: assistants, threads, live runs, channel wiring and deliveries,
> interrupts, time travel, the store, and crons. Served by the server itself, at `/console`.

## What it is

The console is a **client** and stores nothing of its own. Most screens use the standard Agent
Protocol through the real [`@langchain/langgraph-sdk`](./react-sdk.md). Two small skein extensions
cover operational state the upstream SDK does not model: a sanitized channel inventory and a run's
durable delivery attempts. The console subclasses the SDK's transport for these calls, so connection,
authentication and errors use the SDK transport. Run submissions disable automatic retries. A narrow
batch serializer normalizes options the installed SDK does not serialize; a submission-scoped request
hook supplies `timeout_ms` without changing the shared SDK client.

That is a deliberate constraint, not a coincidence. If a view cannot be built, it means the API is
missing something, and we would rather feel that here than paper over it with a bespoke endpoint. (One
gap found exactly this way: there is no cross-thread run search — runs list per thread — so "recent
activity" fans out over threads. See [roadmap](./roadmap.md).)

It ships as [`@skein-js/console`](https://github.com/skein-js/skein-js/tree/main/packages/console): the compiled UI plus a resolver, with **no
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

Because it is served by the server, it is **same origin**: no CORS to configure, no second process, no
account, and it works with no internet connection.

## Turning it on in production

**Off by default** under `skein start` and the production image. The console can read every thread,
memory and schedule on the server, and delete runs, memories and schedules, so enabling it is a
decision you make:

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

## What it shows

The sidebar groups work by purpose: **Build** (Playground, Assistants), **Inspect** (Threads), and
**Operate** (Overview, Channels, Store, Schedules). Playground remains the landing page; existing
hash links, including `#/crons`, still work. Navigation becomes a drawer on phones. The Playground
inspector becomes a drawer below 1024px. Light, dark, and system themes share the same labeled status
colors; teal marks primary actions and selection.

### The playground

<div class="light-only">

![Playground with a conversation, execution summary, and reported activity](/images/console/playground-light.png)

</div>
<div class="dark-only">

![Playground in dark mode with a conversation and Activity inspector](/images/console/playground-dark.png)

</div>

Choose an **Assistant**, a saved graph configuration, then use **Chat** for a graph with a `messages`
channel or **JSON** for structured input. The input schema explains the selected mode and supplies a
JSON example. Each mode keeps its own draft. Threads are created only on submission; validation and
request failures preserve the draft.

The execution summary explains what was observed and what to do next. Reopening a thread restores
its latest run's retained activity through an observer that never cancels execution. **Activity** shows reported
node output, tool calls and results, pauses, and failures. **Graph** highlights nodes that reported
output; this does not establish which node is executing now. **State** shows the latest reported
values. The connection badge describes server reachability separately from execution. Markdown is
rendered without raw HTML, and remote images open only after an explicit click. Reading earlier
output keeps your scroll position.

**Stop run** sends server cancellation. An observer, such as the run detail page, closes its stream
without cancelling execution. An interrupted run displays its originating task and requested value;
**Send true**, **Send false**, and the editable response submit their literal values. A resumed run
is followed until its terminal event.

**Advanced run options** are collapsed initially:

- Run on this thread, an explicit existing thread, a fresh stateless thread, or a batch of **1–100
  JSON objects** for the selected Assistant.
- Delay execution in seconds; choose reject, enqueue, interrupt, or rollback when the thread is busy.
- Set an execution timeout in integer milliseconds, subject to the deployment limit. This control
  requires positive confirmation of `/info.flags.per_run_timeout`; discovery failure leaves ordinary
  operations available.
- Supply an idempotency key, choose completion retention for generated threads, and select captured
  stream modes.

Delayed and keyed submissions are created in the background, then observed. Closing observation
leaves these runs running. A disconnect or ambiguous failure never automatically resubmits input.
Inspect the thread before trying again. A failed batch may already have created some runs.

### Overview

<div class="light-only">

![Overview prioritizing threads waiting for input and errors](/images/console/overview-light.png)

</div>
<div class="dark-only">

![Overview with server counts, freshness, and recent activity in dark mode](/images/console/overview-dark.png)

</div>

Start with threads **waiting for you** or reporting errors, then inspect counts and recent activity.
Freshness labels describe the last successful read. Lists refresh explicitly; only observed runs
stream live. Unavailable counts and failed reads remain visible. Recent activity is bounded to
recent threads because the protocol has no global run search.

### Assistants

Create an Assistant from a registered graph, edit its name/config/context/metadata, preview a saved
version, or restore it using `setLatest`. Deletion keeps threads by default; cascading deletion is an
explicit choice. Assistants registered from graph configuration return at server startup. Deleting
one does not remove the graph from `langgraph.json`.

### Threads, and what is waiting on you

<div class="light-only">

![Paged thread inspection with status filters](/images/console/threads-light.png)

</div>
<div class="dark-only">

![Paged thread inspection in dark mode](/images/console/threads-dark.png)

</div>

Filter by status or recorded graph metadata, open an exact ID, and page through results. Older
threads without a recorded graph may be absent from a graph-filtered result. A thread has focused
**Conversation**, **Runs**, **State**, **Checkpoints**, and **Details** tabs. Structured graphs default
to State. The Assistant is resolved from the latest run, then metadata, then explicit selection.

Copy or delete a thread, trim its checkpoints with `keep_latest`, edit metadata, and inspect/change
retention. Select threads on the current page to prune or delete them. Results report affected and
unchanged/skipped counts rather than assuming every selection changed. Retention is in minutes;
`null` means known no expiry, while missing readback means unavailable. Thread expiry marks
eligibility for background cleanup, which can be deferred by active work.

<div class="light-only">

![An interrupt request and an exact editable JSON response](/images/console/interrupts-light.png)

</div>
<div class="dark-only">

![An interrupt request and response controls in dark mode](/images/console/interrupts-dark.png)

</div>

### Runs

Run details separate **Activity**, **Raw events**, **Deliveries**, and **Details**. The event buffer
retains 500 frames and reports dropped history. Server execution state and observer connection state
are labeled separately. Closing the observer never cancels the run. Explicit cancel, rollback, and
delete actions explain their effects in keyboard-accessible confirmation dialogs.

Deliveries show lifecycle status, attempts, last errors, next retries, and server timestamps. Dead
deliveries can be replayed after confirmation. Delivery is at-least-once: receivers must deduplicate
by the stable delivery ID. Destinations show only the host/path presence or channel name; credentials,
queries, paths, and opaque reply targets remain redacted.

### Channels

Channels is a read-only inventory of effective inbound routes, provider identity, default Assistant,
allowed Assistants, and outbound delivery support. It uses `GET /channels`, which is absent when no
channels are configured. Code and `langgraph.json` remain the source of truth; changes require a
restart. Provider credentials and module configuration are not returned. Custom authorization uses
`assistants:read`; inbound provider events still use channel signature verification.

### Time travel

Checkpoints support **Fork here** (write edited values), **Fork and run**, and **Run from here
unchanged**. Edits go through graph reducers, so an append channel adds values instead of replacing
its history. Review the displayed checkpoint and reducer warning before running forward.

### The store

<div class="light-only">

![Store namespaces, item details, and retention readback](/images/console/store-light.png)

</div>
<div class="dark-only">

![Store namespaces and item retention in dark mode](/images/console/store-dark.png)

</div>

Browse namespaces, filter item values with JSON, and use semantic queries when the deployment
supports them. Open individual items, create values, edit JSON, or delete items. Saving is an
**upsert**: it replaces any value at the same namespace/key and resets expiry using the chosen
lifetime or deployment default. Retention and expiry are shown when the store reports them.

Passive inspection sends `refreshTtl: false` so browsing does not extend sliding expiry. If a custom
adapter rejects per-read TTL controls, the console explains this and offers **Load using normal
reads**, which may refresh expiry. It never silently falls back.

### Crons

The navigation label is **Schedules**; the URL remains `#/crons`. Create stateless or existing-thread
schedules with five-field cron expressions, a timezone, optional end time, and applicable completion
retention. For example, `0 9 * * 1-5` runs at 09:00 on weekdays in the chosen timezone. Scheduling
resolution is one minute. An enabled schedule with no future match is dormant and shows **no
upcoming run**. Pause/resume without deleting. Editing scheduling fields preserves the saved run
payload; it does not replace input or Assistant configuration.

## Boundaries

Lists are paged and refresh on demand. Global run search, graph editing, and separate authentication
or permission management are outside this console. Every operation uses the server's existing
authorization. Destructive resource changes and delivery replay use accessible dialogs with focus
restoration. The foreign-server confirmation at boot remains a browser confirmation, before any
application data is requested; saved API keys stay bound to the server where they were entered.

## Mounting it yourself

The console is route bindings and bytes, so any adapter can serve it. It is not a dependency of the
adapters on purpose — the compiled UI stays under 1 MiB, and mounting the protocol should not cost that.

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

The UI is a static Vite + React SPA (Tailwind, Radix dialogs, and system-aware light/dark themes), built by the `console-ui` Nx project. `nx serve console-ui` is the HMR dev loop.

`nx build console` then chains: build the SPA → compile its files into `src/assets.generated.ts` as
string constants → bundle. That last step is why the package can be a _library_: skein forbids reading
package-relative files at runtime, because bundlers rewrite `import.meta.url` to the output location
(see [bundling.md](./bundling.md)). `@skein-js/storage-postgres` solved the same problem for its SQL;
the console does it for HTML, JS and CSS. A test pins the total size so the CLI's install cost cannot
drift upward unnoticed.

Run `nx run console-ui:test-browser` for real-HTTP deterministic graph scenarios, operation flows,
and responsive light/dark screenshots. It runs in CI alongside the unit tests. The asset test retains
a **1 MiB** uncompressed ceiling; the published package still has zero runtime dependencies.
