// The production `ProtocolDeps` assembler. Given a `langgraph.json` and a chosen store/queue
// driver, it wires the concrete drivers and hands back deps ready for any framework adapter's
// `{ deps }` seam (see @skein-js/express's create-express-server / skein-router). This is the one
// place a production driver is selected — the engine itself stays driver-agnostic.
//
// All-memory delegates to @skein-js/express's reloadable in-memory runtime so `skein dev` keeps its
// hot-reload + cross-restart persistence; Postgres/Redis are assembled here around the same
// reroutable graph resolver so graph hot-reload still works against durable storage.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { MemorySaver } from "@langchain/langgraph";
import type { GraphResolver, GraphSchemas, ProtocolDeps } from "@skein-js/agent-protocol";
import {
  loadAuthEngine,
  loadConfig,
  parseLanggraphJson,
  type GraphRegistry,
  type ModuleImporter,
} from "@skein-js/config";
import type { GraphSchemas as ConfigGraphSchemas } from "@skein-js/config";
import type { TelemetrySink } from "@skein-js/core";
import {
  corsFromHttpConfig,
  loadReloadableInMemoryRuntime,
  resolveMaxPageSize,
  resolveRunConcurrency,
  resolveMemoryBusLimits,
  type DevStateSnapshot,
} from "@skein-js/server-kit";
import { MemoryRunEventBus, MemoryRunQueue, MemorySkeinStore } from "@skein-js/storage-memory";
import type { StoreIndexConfig } from "@skein-js/storage-postgres";
import type { CorsOptions } from "cors";

import {
  connectPostgresStore,
  connectRedisQueue,
  postgresConnectionOptions,
  requireEnv,
  runDisposers,
  startStoreTtlSweeper,
  type Disposer,
} from "./drivers.js";
import { RuntimeConfigError } from "./errors.js";
import { resolveEmbed } from "./resolve-embed.js";
import { resolveTelemetry } from "./resolve-telemetry.js";

/** Where protocol resources (assistants/threads/runs/store) and checkpoints are persisted. */
export type StoreDriver = "memory" | "postgres";
/** Where background runs are queued and stream frames are fanned out. */
export type QueueDriver = "memory" | "redis";

/** Options for {@link buildRuntime}: which `langgraph.json` to load and which drivers to wire. */
export interface BuildRuntimeOptions {
  /** Absolute path to `langgraph.json`. */
  configPath: string;
  /** TS-capable importer (e.g. the CLI's vite loader). Omitted for plain JS/Node resolution. */
  importModule?: ModuleImporter;
  /**
   * Precomputed graph schemas (from `skein build`) for a pre-compiled image — forwarded to
   * `loadConfig` so schema introspection is a map lookup, never a TypeScript parse. Omitted for dev.
   */
  schemas?: Record<string, ConfigGraphSchemas>;
  /** `"memory"` (default dev) or `"postgres"` (reads `POSTGRES_URI`). */
  store: StoreDriver;
  /** `"memory"` (default dev) or `"redis"` (reads `REDIS_URI`). */
  queue: QueueDriver;
  /**
   * The version `GET /info` reports. Passed in by the CLI, which — as an *application* rather than a
   * library — may read its own `package.json`; see `ProtocolDeps.serverVersion`.
   */
  serverVersion?: string;
}

/**
 * The result of {@link buildRuntime}: assembled deps for any adapter's `{ deps }` seam, plus the
 * lifecycle hooks (`reloadGraphs`, `dispose`, and — in all-memory mode — state snapshot/hydrate).
 */
export interface SkeinRuntime {
  /** Assembled dependency bundle to pass as `createExpressServer({ deps })`. */
  deps: ProtocolDeps;
  /** CORS mapped from the config's `http.cors`, or `undefined` when none is declared. */
  cors?: CorsOptions;
  /** Re-read the config and swap in freshly imported graphs, keeping every driver + all state. */
  reloadGraphs(): Promise<void>;
  /** Tear down whichever concrete Postgres/Redis resources were created (no-op for all-memory). */
  dispose(): Promise<void>;
  /** Present only in all-memory mode — durable stores keep their own state. */
  snapshotState?(): DevStateSnapshot;
  /** Present only in all-memory mode. */
  hydrateState?(snapshot: DevStateSnapshot): void;
}

/**
 * A `GraphResolver` that delegates to a swappable config registry, so `reloadGraphs()` can reroute
 * future loads without recreating drivers. Mirrors the trick in @skein-js/express's in-memory
 * runtime; the run engine calls `load()` per run, so the next run picks up reloaded code while all
 * durable state survives.
 */
function reroutableGraphResolver(initial: GraphRegistry): {
  resolver: GraphResolver;
  reroute(next: GraphRegistry): void;
} {
  let current = initial;
  return {
    resolver: {
      ids: initial.ids,
      load: (graphId) => current.load(graphId),
      schemas: async (graphId) => (await current.schemas(graphId)) as unknown as GraphSchemas,
    },
    reroute: (next) => {
      current = next;
    },
  };
}

/**
 * Build the pgvector semantic-search config from `langgraph.json`'s `store.index`, resolving its
 * `embed` value (provider:model or a custom-function path) to an `EmbedFunction`. Returns undefined
 * when no `embed` is configured, in which case Postgres search falls back to naive text matching.
 */
async function resolveStoreIndex(
  index: { embed?: string; dims?: number; fields?: string[]; hnsw?: boolean } | undefined,
  options: { configDir: string; importModule?: ModuleImporter },
): Promise<StoreIndexConfig | undefined> {
  if (!index?.embed) return undefined;
  if (typeof index.dims !== "number") {
    throw new RuntimeConfigError(
      `store.index.embed is set but store.index.dims is missing — set the embedding dimensionality ` +
        `(e.g. 1536 for openai:text-embedding-3-small).`,
    );
  }
  const embed = await resolveEmbed(index.embed, options);
  return { dims: index.dims, fields: index.fields, embed, hnsw: index.hnsw };
}

/**
 * Drain every telemetry sink on shutdown. Batching exporters (PostHog, OTel) lose the tail of a
 * process without this — precisely the events you most want after a crash. Best-effort and never
 * throws: `dispose()` runs from a signal handler whose job is to exit cleanly regardless.
 *
 * The run worker flushes too, for a host that stops the worker without disposing the runtime; a
 * second flush on an already-drained sink is a no-op.
 */
async function flushTelemetry(sinks: readonly TelemetrySink[]): Promise<void> {
  await Promise.allSettled(
    sinks.map(async (sink) => {
      try {
        await sink.flush?.();
      } finally {
        await sink.shutdown?.();
      }
    }),
  );
}

/** Assemble a {@link SkeinRuntime} for the requested driver combination. */
export async function buildRuntime(options: BuildRuntimeOptions): Promise<SkeinRuntime> {
  const { configPath, importModule, store, queue, schemas, serverVersion } = options;

  // All-memory: reuse the express reloadable in-memory runtime verbatim (hot-reload + snapshot).
  if (store === "memory" && queue === "memory") {
    // `skein dev` traces too — watching a graph while you build it is most of the point of LangSmith.
    // Resolved *before* the runtime so the sinks are built into `deps` rather than patched on after:
    // `resolveDeps` spreads its input, so anything that already resolved a copy would never see a
    // later mutation. Reading the manifest here costs one small JSON parse — the expensive part
    // (importing graphs) still happens exactly once, inside `loadReloadableInMemoryRuntime`.
    const configDir = path.dirname(configPath);
    const manifest = parseLanggraphJson(JSON.parse(await readFile(configPath, "utf8")));
    const telemetry = await resolveTelemetry({
      config: manifest.telemetry,
      configDir,
      importModule,
    });
    const runtime = await loadReloadableInMemoryRuntime(
      configPath,
      importModule,
      schemas,
      telemetry.length > 0 ? { telemetry } : undefined,
    );
    // Filled in place rather than copied, matching how `resolveRuntimeDeps` fills the logger: a
    // reloadable runtime hands out the same deps object it keeps.
    if (serverVersion !== undefined) runtime.deps.serverVersion = serverVersion;
    return {
      deps: runtime.deps,
      cors: runtime.cors,
      reloadGraphs: () => runtime.reloadGraphs(),
      dispose: async () => {
        await flushTelemetry(telemetry);
      },
      snapshotState: () => runtime.snapshotState(),
      hydrateState: (snapshot) => runtime.hydrateState(snapshot),
    };
  }

  const first = await loadConfig({ configPath, importModule, staticSchemas: schemas });
  const { resolver, reroute } = reroutableGraphResolver(first.graphs);
  // Track every concrete resource as it is created, so a failure part-way through assembly (a bad
  // migration, a missing REDIS_URI after Postgres already connected) tears down what exists rather
  // than leaking pools/connections. `dispose()` reuses the same list for normal shutdown.
  const disposers: Disposer[] = [];
  const disposeAll = (): Promise<void> => runDisposers(disposers);

  try {
    // Store-item TTL from langgraph.json `store.ttl` (snake_case on the wire → camelCase config).
    const storeTtl = resolveStoreTtl(first.config.store?.ttl);
    // Thread TTL from langgraph.json `checkpointer.ttl` — the same shape LangGraph Platform documents.
    const threadTtl = resolveThreadTtl(first.config.checkpointer?.ttl);
    // `requireEnv` is evaluated eagerly (before any connect), so a missing POSTGRES_URI still throws
    // before a pool is opened. The Postgres store + saver assembly (shared connection tuning, ordered
    // teardown) lives in `connectPostgresStore` — reused by `embedPostgresGraphs`.
    // `threadExecutionGate` comes with the Postgres store: it is the cross-instance per-thread
    // execution claim, and the memory driver has no second instance to coordinate with.
    const {
      store: skeinStore,
      checkpointer,
      threadExecutionGate,
    } = store === "postgres"
      ? await connectPostgresStore({
          url: requireEnv("POSTGRES_URI", "postgres"),
          index: await resolveStoreIndex(first.config.store?.index, {
            configDir: first.configDir,
            importModule,
          }),
          ttl: storeTtl,
          ...(threadTtl ? { threadTtl } : {}),
          connectionOptions: postgresConnectionOptions(),
          maxPageSize: resolveMaxPageSize(),
          runConcurrency: resolveRunConcurrency(),
          disposers,
        })
      : {
          store: new MemorySkeinStore({
            ...(storeTtl ? { ttl: storeTtl } : {}),
            ...(threadTtl ? { threadTtl } : {}),
            maxPageSize: resolveMaxPageSize(),
          }),
          checkpointer: new MemorySaver(),
        };

    // When TTL is configured, sweep expired store items on a background interval (memory or postgres).
    if (storeTtl) startStoreTtlSweeper(skeinStore, storeTtl, disposers);

    // `abortChannel` comes with the Redis queue, for the same reason: it is what carries a cancel to
    // the instance executing the run, and in-memory means there is only this one.
    const {
      queue: runQueue,
      bus,
      abortChannel,
    } = queue === "redis"
      ? connectRedisQueue({ url: requireEnv("REDIS_URI", "redis"), disposers })
      : { queue: new MemoryRunQueue(), bus: new MemoryRunEventBus(resolveMemoryBusLimits()) };

    // Telemetry sinks from the `telemetry` block plus environment auto-detection. Left off the deps
    // entirely when nothing is configured, so the engine's `telemetryEnabled` guards stay false.
    const telemetry = await resolveTelemetry({
      config: first.config.telemetry,
      configDir: first.configDir,
      importModule,
    });

    const deps: ProtocolDeps = {
      store: skeinStore,
      graphs: resolver,
      queue: runQueue,
      bus,
      checkpointer,
      ...(abortChannel ? { abortChannel } : {}),
      ...(threadExecutionGate ? { threadExecutionGate } : {}),
      // Present only when `checkpointer.ttl` is configured, which is what turns the sweeper on.
      ...(threadTtl ? { threadTtl } : {}),
      ...(serverVersion !== undefined ? { serverVersion } : {}),
      auth: await loadAuthEngine(first.config.auth, {
        configDir: first.configDir,
        importModule,
      }),
      ...(telemetry.length > 0 ? { telemetry } : {}),
    };

    return {
      deps,
      cors: corsFromHttpConfig(first.config.http),
      reloadGraphs: async () => {
        reroute((await loadConfig({ configPath, importModule, staticSchemas: schemas })).graphs);
      },
      dispose: async () => {
        // Telemetry first: drain what the run just produced before the drivers underneath it go.
        await flushTelemetry(telemetry);
        await disposeAll();
      },
    };
  } catch (error) {
    await disposeAll();
    throw error;
  }
}

/**
 * Map the langgraph.json `store.ttl` block (snake_case, minutes) to the driver's camelCase
 * {@link StoreTtlConfig}. Returns undefined when no TTL field is set, so stores default to no expiry.
 */
/**
 * Map the langgraph.json `checkpointer.ttl` block to the driver's camelCase {@link ThreadTtlConfig}.
 * Returns undefined when nothing is set, so threads never expire unless asked to.
 *
 * `strategy` is read only to be validated by the schema — `"delete"` is the only thing an expired
 * thread can become, so there is nothing for the drivers to branch on.
 */
function resolveThreadTtl(
  raw: { default_ttl?: number; sweep_interval_minutes?: number } | undefined,
): { defaultTtl?: number; sweepIntervalMinutes?: number } | undefined {
  if (!raw) return undefined;
  const ttl: { defaultTtl?: number; sweepIntervalMinutes?: number } = {};
  if (typeof raw.default_ttl === "number") ttl.defaultTtl = raw.default_ttl;
  if (typeof raw.sweep_interval_minutes === "number") {
    ttl.sweepIntervalMinutes = raw.sweep_interval_minutes;
  }
  return Object.keys(ttl).length > 0 ? ttl : undefined;
}

function resolveStoreTtl(
  raw:
    | { default_ttl?: number; refresh_on_read?: boolean; sweep_interval_minutes?: number }
    | undefined,
): { defaultTtl?: number; refreshOnRead?: boolean; sweepIntervalMinutes?: number } | undefined {
  if (!raw) return undefined;
  const ttl: { defaultTtl?: number; refreshOnRead?: boolean; sweepIntervalMinutes?: number } = {};
  if (typeof raw.default_ttl === "number") ttl.defaultTtl = raw.default_ttl;
  if (typeof raw.refresh_on_read === "boolean") ttl.refreshOnRead = raw.refresh_on_read;
  if (typeof raw.sweep_interval_minutes === "number") {
    ttl.sweepIntervalMinutes = raw.sweep_interval_minutes;
  }
  return Object.keys(ttl).length > 0 ? ttl : undefined;
}
