# @skein-js/server-kit

> Shared, framework-agnostic building blocks for skein-js HTTP adapters.

Part of **[skein-js](../../README.md)** — the open-source alternative to LangGraph Platform for TypeScript: a self-hosted [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

This package is the common ground the framework adapters ([`@skein-js/express`](../server-express),
[`@skein-js/fastify`](../server-fastify), [`@skein-js/nestjs`](../server-nestjs),
[`@skein-js/nextjs`](../server-nextjs)) stand on — so no adapter has to depend on another (or on
Express) just to reuse it. It holds the framework-agnostic pieces (runtime assembly, dev-state import,
CORS, and the Node-`http` transport the Node-based adapters share); each adapter still writes only the
thin request/response shim its framework needs over the [`@skein-js/agent-protocol`](../agent-protocol)
handler table.

## What's here

- **Runtime resolution** — `resolveProtocolRuntime`: turn a `{ config } | { deps }` bag into a live
  runtime (assistants seeded, worker started) — the step every adapter runs before mounting routes.
- **In-memory dev runtime** — `loadInMemoryRuntime` / `loadReloadableInMemoryRuntime`: assemble a
  `ProtocolDeps` backed by in-process drivers from a `langgraph.json`. This is what powers `skein dev`
  and every adapter's `{ config }` convenience path (hot-reload + snapshot/restore included).
- **In-code embedding** — `embedInMemoryGraphs` / `graphMapToResolver`: build a `ProtocolDeps` around a
  compiled graph (or map of them) you already hold — **no `langgraph.json`, no CLI** — then pass
  `{ deps }` to any adapter. `overrides` swaps in production drivers/auth. See
  [docs/embedding.md](../../docs/embedding.md).
- **LangGraph dev-state import** — `readLanggraphDevState` / `loadSnapshotIntoStore` /
  `describeSnapshot`: read an existing `.langgraph_api/` directory and reconstruct skein's own
  `DevStateSnapshot`, so adopting skein carries all local state over losslessly.
- **CORS** — `corsFromHttpConfig` / `toCorsOptions` map a `langgraph.json` `http.cors` block to
  `cors`-style `CorsOptions`; `allowedOrigin` / `corsResponseHeaders` / `applyNodeCors` /
  `sendNodePreflight` derive CORS headers for the adapters without a CORS middleware of their own
  (an unset origin resolves to `*`, never a reflected origin, so it can't pair with credentials).
- **Node transport** — `sendNodeResponse` / `sendNodeError`: serialize a `ProtocolResponse` (JSON / 204
  / SSE) onto a Node `ServerResponse`, shared by the NestJS + Next.js Pages Router adapters.
- **Mount prefix** — `stripBasePath`: strip the path an adapter is mounted under before matching the
  route table, for adapters that mount a catch-all and match by hand (NestJS, Next.js).
- **Logging** — `createConsoleLogger`: the opt-in `Logger` for adapters whose framework owns none
  (Express, Next.js). `formatLogMeta` / `describeError` are the shared rendering every line-oriented
  logger needs — a failed run's identity, stack, and `cause` chain — so the framework bridges and the
  CLI's dev logger can't drift on how a failure reads.

> The route table itself (`skeinRoutes`) is **not** here — it lives with the engine in
> [`@skein-js/agent-protocol`](../agent-protocol), since it references the handler names. Adapters
> import it from there.

## Install

```bash
pnpm add @skein-js/server-kit @langchain/langgraph
```

`@langchain/langgraph` is a peer dependency. You install this package directly when you **embed a
graph in code** (`embedInMemoryGraphs`) or **write your own adapter**; the shipped adapters depend on
it for you.

## Usage

The most common direct use is the in-code on-ramp — turn a compiled graph (or a map of them) into a
`ProtocolDeps` and hand `{ deps }` to any adapter, with **no `langgraph.json` and no CLI**:

```ts
import { createExpressServer } from "@skein-js/express";
import { embedInMemoryGraphs } from "@skein-js/server-kit";
import { graph } from "./my-graph.js";

const server = await createExpressServer({ deps: embedInMemoryGraphs({ agent: graph }) });
await server.listen(2024);
```

Pass `overrides` to swap in production drivers or an auth engine while keeping the rest in-memory. See
[docs/embedding.md](../../docs/embedding.md).

## API

- **`embedInMemoryGraphs(graphs, options?): ProtocolDeps`** — build a `ProtocolDeps` (store, queue,
  bus, checkpointer) around a compiled graph or `Record<string, EmbeddableGraph>`. `options.overrides`
  replaces any dep (e.g. a Postgres store, an `auth` engine). `createInMemoryDeps` is a
  **`@deprecated`** alias. `graphMapToResolver` / `normalizeEmbeddableGraphs` are the lower-level
  graph→`GraphResolver` helpers.
- **`resolveProtocolRuntime(options, frameworkLogger?): Promise<ResolvedProtocolRuntime>`** — turn a
  `{ config } | { deps }` bag (`SkeinRuntimeOptions`) into a live runtime (assistants seeded, worker
  started) — the step every adapter runs before mounting routes. `options.worker`
  (`RunWorkerOptions`) tunes the background worker; `worker.maxConcurrency` is how many queued runs
  run at once. `frameworkLogger` is the adapter's own default, applied only when the caller supplied
  neither `options.logger` nor `deps.logger`; the result's `.logger` is the winner, which the adapter
  should also use for its transport-fault logging.
- **`createConsoleLogger(options?): Logger`** — a plain `console.*` logger (`level`, `prefix`), for
  adapters whose framework owns none. `formatLogMeta(meta)` / `describeError(thrown)` render a failed
  run's identity, stack, and `cause` chain as text.
- **`resolveRunConcurrency(explicit?, env?): number`** — the one precedence chain behind
  `worker.maxConcurrency`: explicit value → `SKEIN_RUN_CONCURRENCY` → `N_JOBS_PER_WORKER` →
  `DEFAULT_RUN_CONCURRENCY` (10, matching the LangGraph CLI). The environment is validated even when
  an explicit value is given, so the two sources can't silently disagree. `skein dev`/`start` use it
  to resolve the number they print in the startup banner.
- **`resolveMaxPageSize(explicit?, env?): number`** — the same chain for the store page bound:
  explicit `maxPageSize` → `SKEIN_MAX_PAGE_SIZE` → `DEFAULT_MAX_PAGE_SIZE` (1000). Every driver applies
  it to list/search, including when the caller asks for no limit.
- **`loadInMemoryRuntime` / `loadReloadableInMemoryRuntime`** — assemble a `ProtocolDeps` from a
  `langgraph.json` using in-process drivers. The reloadable variant adds `reloadGraphs` /
  `snapshotState` / `hydrateState` (what powers `skein dev`'s hot reload + cross-restart persistence).
- **`readLanggraphDevState` / `loadSnapshotIntoStore` / `describeSnapshot`** — read an existing
  `.langgraph_api/` directory and reconstruct a `DevStateSnapshot`, so adopting skein carries local
  state over losslessly.
- **CORS** — `corsFromHttpConfig` / `toCorsOptions` map a `langgraph.json` `http.cors` block to
  `cors`-style options; `allowedOrigin` / `corsResponseHeaders` / `applyNodeCors` / `sendNodePreflight`
  derive CORS headers for adapters without a CORS middleware of their own.
- **Node transport** — `sendNodeResponse` / `sendNodeError` serialize a `ProtocolResponse`
  (JSON / 204 / SSE) onto a Node `ServerResponse`, shared by the NestJS + Next.js Pages Router adapters.
- **`stripBasePath(pathname, basePath): string | null`** — the pathname relative to a mount prefix, or
  `null` when the path is not under it (the caller passes those through untouched). The prefix may be
  written any way the host wrote it (`api`, `/api`, `/api/`); an empty one passes everything through.
  Needed only by adapters that mount a catch-all — Express/Fastify get this from their router.

## Learn more

- [Building your own adapter](../../docs/building-an-adapter.md)
- [skein-js overview](../../docs/index.md)

## License

[Apache-2.0](../../LICENSE)
