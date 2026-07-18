# @skein-js/server-kit

> Shared, framework-agnostic building blocks for skein-js HTTP adapters.

Part of **[skein-js](../../README.md)** — a TypeScript [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server for [LangGraph.js](https://github.com/langchain-ai/langgraphjs), and a drop-in replacement for the LangGraph CLI.

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

> The route table itself (`skeinRoutes`) is **not** here — it lives with the engine in
> [`@skein-js/agent-protocol`](../agent-protocol), since it references the handler names. Adapters
> import it from there.

## Learn more

- [Building your own adapter](../../docs/building-an-adapter.md)
- [skein-js overview](../../docs/index.md)

## License

[Apache-2.0](../../LICENSE)
