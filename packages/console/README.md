# @skein-js/console

The **skein console** — a web UI for a running [skein](https://github.com/skein-js/skein-js) server:
assistants, threads, live runs, interrupts, time travel, the store, and crons.

Served by the server itself, so it is same-origin: no CORS, no second process, no account, and it works
with no internet connection.

```
skein dev                     # console at http://127.0.0.1:2024/console/
skein dev --no-console        # leave it out
```

In production it is **off unless asked for**, because it can read and delete every thread, memory and
schedule on the server:

```jsonc
{ "http": { "console": true } } // langgraph.json — or a path: "/admin/console"
```

Full documentation: **[docs/console.md](../../docs/console.md)**.

## Mounting it in your own server

```ts
import { consoleAssetHeaders, resolveConsoleRequest } from "@skein-js/console";

app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const resolution = resolveConsoleRequest(req.path, { mountPath: "/console" });
  if (resolution.kind === "miss") return next();
  if (resolution.kind === "redirect") return res.redirect(302, resolution.location);
  res.set(consoleAssetHeaders(resolution.asset));
  return res.status(200).send(Buffer.from(resolution.asset.bytes));
});
```

## What is in this package

**Compiled bytes and a resolver — nothing else.** The UI (React, shadcn/ui, the LangGraph SDK) is built
to static files and embedded as string constants, so this package has **no runtime dependencies**, reads
no files at runtime, and bundles cleanly into a consumer's server (see
[docs/bundling.md](../../docs/bundling.md)).

| Export                                           | What it does                                             |
| ------------------------------------------------ | -------------------------------------------------------- |
| `resolveConsoleRequest(pathname, { mountPath })` | Resolve a request to an asset, a redirect, or a miss.    |
| `resolveConsoleAsset(pathWithinMount, …)`        | The same, with the mount prefix already stripped.        |
| `consoleAssetHeaders(asset)`                     | Content type, length, cache policy, `nosniff`.           |
| `normalizeMountPath(path)`                       | Leading slash, no trailing slash, `/console` when unset. |
| `consoleAssetFiles()`                            | Every bundled file path.                                 |
| `CONSOLE_ASSETS_BYTES`                           | Total uncompressed size — pinned by a budget test.       |

## Working on it

The UI is the `console-ui` Nx project in [`ui/`](./ui):

```bash
nx serve console-ui     # Vite dev server with HMR (point it at a running skein via ?baseUrl=)
nx build console        # build the SPA → compile assets in → bundle the package
nx test console         # resolver contract + size budget
```

`src/assets.generated.ts` is generated, not committed. `build`, `typecheck` and `test` all depend on the
`generate-assets` target, so it cannot go stale.

The console is a **client**: it adds no endpoints and holds no server-side state. If a view cannot be
built from the Agent Protocol surface, that is a gap in the API to write down — not a reason to add one.
