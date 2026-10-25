# @skein-js/local

Embed LangGraph.js agents with durable SQLite resources, checkpoints and queued work on Node 22/24/26.

📖 **Docs:** [Local deployment](https://skein-js.github.io/skein-js/local-deployment#embed-agents)

```sh
npm install @skein-js/local @langchain/langgraph @langchain/langgraph-checkpoint-sqlite@~1.0.4
```

```ts
import { embedSqliteGraphs } from "@skein-js/local";
import { createProtocolRuntime } from "@skein-js/agent-protocol";

const local = await embedSqliteGraphs(
  { assistant: graph },
  {
    sqlitePath: "/absolute/application-data/state.sqlite",
  },
);
const runtime = createProtocolRuntime(local.deps);
await runtime.service.assistants.registerGraphAssistants();
runtime.worker.start();
// Use runtime.createNativeClient({sourceId, allowedAssistants}) for receipt-based native work.
// The existing runtime.service and HTTP adapters remain available.
await runtime.worker.stop();
await local.dispose();
```

`EmbedSqliteGraphsOptions` accepts the required absolute `sqlitePath`, existing page/TTL options,
and `overrides` for non-owned protocol dependencies such as auth, logger, telemetry, clock, webhooks
and `storeItems`. Graphs, storage, queue, bus and checkpoint bindings remain owned by the helper.
The result is `{ deps, dispose }`; disposal is idempotent.

Assembly starts no assistants, protocol workers, HTTP listeners, desktop processes or signal handlers.
The host chooses its application-data directory and process lifetime. An Electron utility process,
a packaged Node backend for Tauri, a separate daemon, or a terminal application can own the same
assembly. A UI talks to the existing Agent Protocol with the existing LangGraph SDK.

LangGraph's SQLite saver shares the driver's borrowed native connection. Live event frames remain
in memory; reopening restores records and checkpoints, rather than a token transcript. Abandoned
attempts are recorded as failures and are not replayed automatically. Models and tools remain part
of the application's graphs.

See [local deployment](https://skein-js.github.io/skein-js/local-deployment), [CLI](../../examples/local-cli/README.md),
[Electron](../../examples/desktop-electron/README.md) and [Tauri](../../examples/desktop-tauri/README.md).
