// Build an in-memory `ProtocolDeps` from statically-imported graphs. Next.js bundles these graph
// modules with the app, so this works under both `next dev` and `next build`/`next start` — unlike
// the `{ config }` path, which would dynamically `import()` a `.ts` graph file at runtime (no TS
// loader in a Next server). This is the injected-`deps` seam every skein adapter accepts.
//
// For serverless/edge deploys where no single process stays warm, swap these in-memory drivers for
// the Redis queue + Postgres store (see @skein-js/runtime's `buildRuntime`).

import { MemorySaver } from "@langchain/langgraph";
import type { GraphResolver, GraphSchemas, ProtocolDeps } from "@skein-js/agent-protocol";
import { MemoryRunEventBus, MemoryRunQueue, MemorySkeinStore } from "@skein-js/storage-memory";

// `echo` is a pure, zero-setup graph — safe to import statically. `agent` constructs a `ChatGoogleGenerativeAI`
// at module load (which throws without GOOGLE_API_KEY), so it is imported lazily, only when the
// `agent` graph is actually requested — that keeps a keyless build and the echo path model-free.
import { graph as echo } from "../graphs/echo-graph";

type Loaded = Awaited<ReturnType<GraphResolver["load"]>>;

const resolver: GraphResolver = {
  ids: ["echo", "agent"],
  load: async (graphId) => {
    if (graphId === "echo") return echo as unknown as Loaded;
    if (graphId === "agent") {
      return (await import("../graphs/agent-graph")).graph as unknown as Loaded;
    }
    throw new Error(`Unknown graph "${graphId}".`);
  },
  schemas: async (graphId) => ({ [graphId]: { graph_id: graphId } }) as unknown as GraphSchemas,
};

export const deps: ProtocolDeps = {
  store: new MemorySkeinStore(),
  graphs: resolver,
  queue: new MemoryRunQueue(),
  bus: new MemoryRunEventBus(),
  checkpointer: new MemorySaver(),
};
