// Assemble a `ProtocolDeps` around graphs you already hold in code — the config-free counterpart to
// `loadInMemoryRuntime` (which reads a `langgraph.json`). This is the public seam for embedding skein
// into an app that never adopted the LangGraph Platform's project shape: bring a compiled graph (or a
// map of them) and get a full Agent Protocol runtime backed by in-process drivers, then hand it to any
// adapter's `{ deps }` seam. Swap any driver via `overrides` (e.g. the Postgres store + Redis queue
// from `@skein-js/runtime`) for a durable, horizontally-scalable deployment. See docs/embedding.md.

import { MemorySaver } from "@langchain/langgraph";
import type { GraphResolver, ProtocolDeps } from "@skein-js/agent-protocol";
import {
  cloneLangGraphCheckpoint,
  normalizeEmbeddableGraphs,
  type EmbeddableGraph,
  SkeinBaseStore,
} from "@skein-js/langgraph";
import { MemoryRunEventBus, MemoryRunQueue, MemorySkeinStore } from "@skein-js/storage-memory";

import { resolveMaxPageSize } from "./max-page-size.js";
import { resolveMemoryBusLimits } from "./memory-bus-limits.js";
import { resolveWebhooks } from "./webhooks-config.js";

export {
  graphMapToResolver,
  normalizeEmbeddableGraphs,
  type EmbeddableGraph,
} from "@skein-js/langgraph";

/**
 * Build a `ProtocolDeps` backed by fresh in-process drivers (store, queue, bus, checkpointer) around
 * graphs you already hold in code — no `langgraph.json`, no CLI. Pass a map of compiled graphs (or
 * factories), or a ready {@link GraphResolver}. Hand the result to any adapter's `{ deps }` seam:
 *
 * ```ts
 * import { embedInMemoryGraphs } from "@skein-js/server-kit";
 * import { createExpressServer } from "@skein-js/express";
 *
 * createExpressServer({ deps: embedInMemoryGraphs({ myAgent: graph }) }).listen(2024);
 * ```
 *
 * `overrides` replaces any driver or adds `auth`/`logger` — e.g. swap in a Postgres store + Redis
 * queue for a durable, horizontally-scalable deployment. `graphs` is intentionally excluded from
 * `overrides` (the first argument is the single source of graphs), so a stray `graphs` key can't
 * silently void it.
 */
export function embedInMemoryGraphs(
  graphs: GraphResolver | Record<string, EmbeddableGraph>,
  overrides: Omit<Partial<ProtocolDeps>, "graphs"> = {},
): ProtocolDeps {
  // `resolveWebhooks(undefined)` answers `undefined` unless the environment actually configures
  // something, so a host that sets nothing keeps exactly the deps it had before this existed.
  const webhooks = resolveWebhooks(undefined);
  return {
    // `maxPageSize` resolved for the same reason as the bus limits below: an embedded host's
    // `SKEIN_MAX_PAGE_SIZE` has to reach the driver that applies it.
    store: new MemorySkeinStore({ maxPageSize: resolveMaxPageSize() }),
    graphs: normalizeEmbeddableGraphs(graphs),
    queue: new MemoryRunQueue(),
    // Resolved rather than defaulted, so `SKEIN_MEMORY_BUS_*` reaches an embedded host too — this is
    // the driver set a long-lived single-process deployment actually runs on.
    bus: new MemoryRunEventBus(resolveMemoryBusLimits()),
    checkpointer: new MemorySaver(),
    // Bridges long-term memory into a LangGraph `BaseStore` so nodes reach it via `getStore()`. A
    // function on deps rather than an import inside the engine — see `ProtocolDeps.storeBridge`.
    storeBridge: (store) => new SkeinBaseStore(store),
    // Throwaway saver for `POST /invoke/:graph_id` — see `ProtocolDeps.ephemeralCheckpointer`.
    ephemeralCheckpointer: () => new MemorySaver(),
    // Clones a checkpoint before it is re-put under another thread id — see `ProtocolDeps.cloneCheckpoint`.
    cloneCheckpoint: cloneLangGraphCheckpoint,
    // Resolved for the same reason as `maxPageSize` and the bus limits: an embedded host's env has to
    // reach the code that applies it. Without this, a host that sets `SKEIN_WEBHOOK_SECRET` and
    // follows the docs gets callbacks that are silently **unsigned** — a fail-open indistinguishable
    // from a working setup, since an unsigned callback is delivered exactly like a signed one and only
    // the receiver ever finds out. There is no `langgraph.json` on this path, so the env var is the
    // only input; `overrides` still spreads last and wins.
    ...(webhooks ? { webhooks } : {}),
    ...overrides,
  };
}

/**
 * @deprecated Renamed to {@link embedInMemoryGraphs} — the function takes graphs and returns a
 * `ProtocolDeps`, not a graph. Kept for back-compat; slated for removal in a future major.
 */
export const createInMemoryDeps = embedInMemoryGraphs;
