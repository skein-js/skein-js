// Assemble a `ProtocolDeps` backed entirely by in-process drivers — the zero-setup runtime that
// powers `skein dev`. This is the ONLY place the adapter reaches for a concrete storage driver;
// everything else is driver-agnostic, so `skein up` can supply Postgres + Redis deps through the
// same seam (see skein-router.ts's `{ deps }` form).

import { MemorySaver } from "@langchain/langgraph";
import type { GraphResolver, GraphSchemas, ProtocolDeps } from "@skein-js/agent-protocol";
import {
  loadAuthEngine,
  loadConfig,
  type GraphRegistry,
  type GraphSchemas as ConfigGraphSchemas,
  type ModuleImporter,
} from "@skein-js/config";
import { MemoryRunEventBus, MemoryRunQueue, MemorySkeinStore } from "@skein-js/storage-memory";
import type { CorsOptions } from "cors";

import { corsFromHttpConfig } from "./cors-config.js";
import {
  hydrateCheckpointer,
  snapshotCheckpointer,
  type DevStateSnapshot,
} from "./dev-persistence.js";

/**
 * Bridge a config `GraphRegistry` to the engine's `GraphResolver`. They are structurally identical
 * except for `schemas()`: config extracts schemas via `@langchain/langgraph-api`, whose `GraphSchema`
 * omits the SDK's `graph_id`. The shapes are otherwise the same, so the nominal gap is cast away here
 * (the same cast `@skein-js/agent-protocol`'s own fixtures use).
 */
function toGraphResolver(graphs: GraphRegistry): GraphResolver {
  return {
    ids: graphs.ids,
    load: (graphId) => graphs.load(graphId),
    schemas: async (graphId) => (await graphs.schemas(graphId)) as unknown as GraphSchemas,
  };
}

/** Fresh in-memory drivers (store, queue, bus, checkpointer) around a graph resolver. */
function buildInMemoryDeps(graphs: GraphResolver): ProtocolDeps {
  return {
    store: new MemorySkeinStore(),
    graphs,
    queue: new MemoryRunQueue(),
    bus: new MemoryRunEventBus(),
    checkpointer: new MemorySaver(),
  };
}

export type { DevStateSnapshot } from "./dev-persistence.js";

export interface InMemoryRuntimeConfig {
  /** In-memory `ProtocolDeps` (store, queue, bus, checkpointer) around the config's graphs. */
  deps: ProtocolDeps;
  /** CORS mapped from the config's `http.cors`, or `undefined` when none is declared. */
  cors?: CorsOptions;
}

/** Load `langgraph.json`, wiring fresh in-memory drivers and reading its `http.cors` for the adapter. */
export async function loadInMemoryRuntime(
  configPath: string,
  importModule?: ModuleImporter,
  staticSchemas?: Record<string, ConfigGraphSchemas>,
): Promise<InMemoryRuntimeConfig> {
  const { graphs, config, configDir } = await loadConfig({
    configPath,
    importModule,
    staticSchemas,
  });
  const deps = buildInMemoryDeps(toGraphResolver(graphs));
  deps.auth = await loadAuthEngine(config.auth, { configDir, importModule });
  return {
    deps,
    cors: corsFromHttpConfig(config.http),
  };
}

export interface ReloadableInMemoryRuntime extends InMemoryRuntimeConfig {
  /**
   * Re-read the config and swap in freshly imported graphs, keeping the same drivers. Because the
   * run engine calls `graphs.load()` per run (it never caches the compiled graph itself), the next
   * run picks up the new code while every thread, run, checkpoint, and store item survives. This is
   * what lets `skein dev` hot-reload graph source without dropping in-memory state.
   */
  reloadGraphs(): Promise<void>;
  /** A JSON-serializable snapshot of all dev state (protocol store + checkpoints). */
  snapshotState(): DevStateSnapshot;
  /** Restore dev state from a {@link snapshotState} — call before the server starts serving. */
  hydrateState(snapshot: DevStateSnapshot): void;
}

/**
 * Like {@link loadInMemoryRuntime}, but the returned `deps.graphs` delegates to a swappable config
 * registry so graphs can be reloaded in place, and it can snapshot/restore its dev state. `skein
 * dev` pairs this with vite's watcher (clear vite's cache, then `reloadGraphs()` — no server
 * restart, no lost state) and with on-disk JSON persistence across restarts.
 */
export async function loadReloadableInMemoryRuntime(
  configPath: string,
  importModule?: ModuleImporter,
  staticSchemas?: Record<string, ConfigGraphSchemas>,
): Promise<ReloadableInMemoryRuntime> {
  const first = await loadConfig({ configPath, importModule, staticSchemas });
  let current: GraphRegistry = first.graphs;

  // The resolver delegates to `current` on every call, so swapping it below reroutes future loads.
  const graphs: GraphResolver = {
    ids: first.graphs.ids,
    load: (graphId) => current.load(graphId),
    schemas: async (graphId) => (await current.schemas(graphId)) as unknown as GraphSchemas,
  };

  // Hold the concrete drivers so their state can be snapshot/restored for cross-restart persistence.
  const store = new MemorySkeinStore();
  const checkpointer = new MemorySaver();
  const deps: ProtocolDeps = {
    store,
    graphs,
    queue: new MemoryRunQueue(),
    bus: new MemoryRunEventBus(),
    checkpointer,
    auth: await loadAuthEngine(first.config.auth, { configDir: first.configDir, importModule }),
  };

  return {
    deps,
    cors: corsFromHttpConfig(first.config.http),
    reloadGraphs: async () => {
      current = (await loadConfig({ configPath, importModule, staticSchemas })).graphs;
    },
    snapshotState: () => ({
      version: 1,
      store: store.snapshot(),
      checkpoints: snapshotCheckpointer(checkpointer),
    }),
    hydrateState: (snapshot) => {
      store.hydrate(snapshot.store);
      hydrateCheckpointer(checkpointer, snapshot.checkpoints);
    },
  };
}
