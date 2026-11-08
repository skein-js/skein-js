# @skein-js/console

The **skein console** — a web UI for a running [skein](https://github.com/skein-js/skein-js) server:
assistants, threads, live runs, channel wiring and deliveries, interrupts, time travel, the store,
and crons.

Part of **[skein-js](https://skein.js.org/)** — the open-source TypeScript runtime for
LangGraph.js agents on shared servers or in local applications.

[Choose where to run](https://skein.js.org/#run-it-your-way) ·
[See who can connect](https://skein.js.org/#who-can-connect)

📖 **Docs:** [The console](https://skein.js.org/console)

Served by the server itself, so it is same-origin: no CORS, no second process, no account, and it works
with no internet connection.

```
skein dev                     # console at http://127.0.0.1:2024/console/
skein dev --no-console        # leave it out
```

In production it is **off unless asked for**, and uses the server's authorization for resource access and changes:

```jsonc
{ "http": { "console": true } } // langgraph.json — or a path: "/admin/console"
```

Start with **[Test your graph in the console](https://skein.js.org/console)**.
Then add [automated project tests](https://skein.js.org/testing-your-project).
Connection, authentication, and advanced controls are in the
[setup reference](https://skein.js.org/console-reference).

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

<span id="what-is-in-this-package"></span>

## Published API

**Compiled bytes and a resolver — nothing else.** The UI (React, shadcn/ui, the LangGraph SDK) is built
to static files and embedded as string constants, so this package has **no runtime dependencies**, reads
no files at runtime, and bundles cleanly into a consumer's server (see
[docs/bundling.md](https://skein.js.org/bundling)).

| Export                                           | What it does                                             |
| ------------------------------------------------ | -------------------------------------------------------- |
| `resolveConsoleRequest(pathname, { mountPath })` | Resolve a request to an asset, a redirect, or a miss.    |
| `resolveConsoleAsset(pathWithinMount, …)`        | The same, with the mount prefix already stripped.        |
| `consoleAssetHeaders(asset)`                     | Content type, length, cache policy, `nosniff`.           |
| `normalizeMountPath(path)`                       | Leading slash, no trailing slash, `/console` when unset. |
| `consoleAssetFiles()`                            | Every bundled file path.                                 |
| `CONSOLE_ASSETS_BYTES`                           | Total uncompressed size — pinned by a budget test.       |

## Working on it

Contributor setup, build details, and browser checks are in
[Developing the console](https://github.com/skein-js/skein-js/blob/main/CONTRIBUTING.md#developing-the-console).
