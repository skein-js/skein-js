// Load a `langgraph.json` into a `ProtocolDeps` backed by in-process drivers — the zero-setup runtime
// that powers `skein dev`. The config-free counterpart (bring a compiled graph in code, no config file)
// is `embedInMemoryGraphs` in ./in-memory-deps.ts, and both entry points here build their deps *through*
// it, so there is exactly one in-memory assembly site and `skein up` can still swap Postgres + Redis
// deps through the adapters' `{ deps }` seam (see skein-router.ts).

import { MemorySaver } from "@langchain/langgraph";
import type {
  GraphResolver,
  GraphSchemas,
  ProtocolDeps,
  RouteBinding,
} from "@skein-js/agent-protocol";
import {
  loadAuthEngine,
  loadChannels,
  loadConfig,
  type GraphRegistry,
  type GraphSchemas as ConfigGraphSchemas,
  type LanggraphJson,
  type ModuleImporter,
  type LoadedChannel,
} from "@skein-js/config";
import { MemorySkeinStore } from "@skein-js/storage-memory";
import type { CorsOptions } from "cors";

import { corsFromHttpConfig, routesFromHttpConfig } from "./cors-config.js";
import {
  hydrateCheckpointer,
  snapshotCheckpointer,
  type DevStateSnapshot,
} from "./dev-persistence.js";
import { resolveIdempotency } from "./idempotency-config.js";
import { embedInMemoryGraphs } from "./in-memory-deps.js";
import { resolveMaxPageSize } from "./max-page-size.js";
import { resolveStoreTtl, resolveThreadTtl } from "./ttl-config.js";
import { resolveWebhooks } from "./webhooks-config.js";

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

export type { DevStateSnapshot } from "./dev-persistence.js";

export interface InMemoryRuntimeConfig {
  /** In-memory `ProtocolDeps` (store, queue, bus, checkpointer) around the config's graphs. */
  deps: ProtocolDeps;
  /** CORS mapped from the config's `http.cors`, or `undefined` when none is declared. */
  cors?: CorsOptions;
  /** The route table to mount, with any `http.disable_*` groups already removed. */
  routes: readonly RouteBinding[];
  /**
   * Channel modules named by `skein.channels`, already imported, keyed by name.
   *
   * Empty when none is configured, which is what keeps the channel routes out of the table entirely
   * rather than merely disabled.
   */
  channels?: Record<string, LoadedChannel>;
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
  const deps = embedInMemoryGraphs(toGraphResolver(graphs));
  deps.auth = await loadAuthEngine(config.auth, { configDir, importModule });
  return {
    deps,
    channels: await loadChannels(config.skein?.channels, {
      configDir,
      ...(importModule ? { importModule } : {}),
    }),
    cors: corsFromHttpConfig(config.http),
    routes: routesFromHttpConfig(config.http),
  };
}

export interface ReloadableInMemoryRuntime extends InMemoryRuntimeConfig {
  /**
   * The parsed `langgraph.json`, so a caller that needs a block this runtime doesn't act on itself
   * (`telemetry`, say) can read it without a second `loadConfig` — which would re-import every graph.
   */
  config: LanggraphJson;
  /** Directory holding `langgraph.json`, for resolving paths declared relative to it. */
  configDir: string;
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
  /**
   * Extra deps to build in, for a caller that acts on a config block this runtime doesn't itself
   * read (`telemetry`). Merged **into** the constructed `deps`, so every consumer sees the same
   * object — patching the returned `deps` afterwards would miss anything that already snapshotted it
   * (`resolveDeps` spreads, it doesn't alias).
   */
  extraDeps?: Partial<Omit<ProtocolDeps, "graphs">>,
): Promise<ReloadableInMemoryRuntime> {
  const first = await loadConfig({ configPath, importModule, staticSchemas });
  let current: GraphRegistry = first.graphs;

  // The resolver delegates to `current` on every call, so swapping it below reroutes future loads.
  // Left unwrapped: `embedInMemoryGraphs` runs it through `langGraphResolver` below, which is what these
  // graphs need (they come from `langgraph.json` and are therefore LangGraph graphs — the engine emits a
  // command envelope and the binding is what turns it back into a `Command`).
  const graphs: GraphResolver = {
    ids: first.graphs.ids,
    load: (graphId) => current.load(graphId),
    schemas: async (graphId) => (await current.schemas(graphId)) as unknown as GraphSchemas,
  };

  // Hold the concrete drivers so their state can be snapshot/restored for cross-restart persistence.
  //
  // Both TTL blocks are read from this runtime's own config, like `auth` below — not passed in via
  // `extraDeps`, because the *store* is what needs them (a default item/thread lifetime is stamped at
  // write time) and the store is built here. Reading one and not the other is how `skein dev` came to
  // honour thread expiry while silently dropping store-item expiry.
  const threadTtl = resolveThreadTtl(first.config.checkpointer?.ttl);
  const storeTtl = resolveStoreTtl(first.config.store?.ttl);
  // Read here for the same reason as the TTL blocks above, though not for the same consumer: the
  // engine reads it, not the store. It has to be resolved on this path anyway, or `skein.idempotency`
  // would tune retention under `skein start` and be silently ignored under `skein dev`.
  const idempotency = resolveIdempotency(first.config.skein?.idempotency);
  // Same story for `skein.webhooks`: resolved here as well as in `buildRuntime`'s durable branch, or
  // a retry policy would work under `skein start` and silently do nothing under `skein dev`.
  const webhooks = resolveWebhooks(first.config.skein?.webhooks, {
    warn: (message) => console.warn(message),
  });
  const store = new MemorySkeinStore({
    maxPageSize: resolveMaxPageSize(),
    ...(threadTtl ? { threadTtl } : {}),
    ...(storeTtl ? { ttl: storeTtl } : {}),
  });
  const checkpointer = new MemorySaver();
  // Built *through* `embedInMemoryGraphs` rather than by hand. Hand-assembling this is how `skein dev`
  // came to run without `storeBridge`, `cloneCheckpoint` and `ephemeralCheckpointer` — the three deps
  // that bind the engine to LangGraph — while the embed paths had them all along. The engine reaches
  // each one optionally (`deps.storeBridge?.(…)`), so every consequence was silent: a node's
  // `config.store`/`getStore()` was `undefined` so long-term memory writes vanished, a thread copy or
  // rollback re-`put` the *source* thread's own mutable checkpoint object, and `POST /invoke/:graph_id`
  // had no throwaway saver. Going through the one assembler leaves nothing to drift.
  //
  // Only what this path genuinely differs on is overridden: the store carries `maxPageSize` and both
  // TTLs, and both it and the checkpointer are held above so their state can be snapshot and restored.
  // `queue` and `bus` are deliberately absent — `embedInMemoryGraphs` builds the same `MemoryRunQueue`
  // and a `MemoryRunEventBus(resolveMemoryBusLimits())`, so the bounds still reach the longest-lived
  // memory bus skein runs (this is the path `skein start` and `skein up` take by default).
  const deps: ProtocolDeps = embedInMemoryGraphs(graphs, {
    store,
    checkpointer,
    auth: await loadAuthEngine(first.config.auth, { configDir: first.configDir, importModule }),
    // Present only when configured — its presence is what starts the thread TTL sweeper.
    ...(threadTtl ? { threadTtl } : {}),
    // Unlike `threadTtl`, absence here means *defaults*, not *off*: the header is honoured either way.
    ...(idempotency ? { idempotency } : {}),
    // Resolved from this runtime's config, which `resolveWebhooks` already merges with the environment
    // — so this subsumes the env-only value `embedInMemoryGraphs` computes, and overrides spread last.
    ...(webhooks ? { webhooks } : {}),
    ...extraDeps,
  });

  return {
    deps,
    // Loaded here so the modules are imported once, with the same importer the graphs used — under
    // `skein dev` that is the vite-backed one, which is what lets a channel be a TypeScript file in
    // the user's own repo rather than something they have to build first.
    channels: await loadChannels(first.config.skein?.channels, {
      configDir: first.configDir,
      ...(importModule ? { importModule } : {}),
    }),
    cors: corsFromHttpConfig(first.config.http),
    routes: routesFromHttpConfig(first.config.http),
    config: first.config,
    configDir: first.configDir,
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
