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
import { withStoreItems } from "@skein-js/agent-protocol";
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
import { cloneLangGraphCheckpoint, langGraphResolver, SkeinBaseStore } from "@skein-js/langgraph";
import {
  corsFromHttpConfig,
  loadReloadableInMemoryRuntime,
  resolveIdempotency,
  resolveWebhooks,
  resolveStoreTtl,
  resolveThreadTtl,
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
import { resolveStoreAdapter } from "./resolve-store-adapter.js";
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
  /**
   * Present only in all-memory mode — durable stores keep their own state.
   *
   * **A configured `store.adapter` is excluded from the snapshot, and deliberately.** The snapshot is the
   * memory driver's own rows, and with an adapter nothing writes long-term items there: every reader and
   * writer goes through `deps.storeItems`. Enumerating the adapter instead would mean serializing whatever
   * store the user brought — quite possibly a live Postgres — into `.skein/dev-state.json` on every
   * autosave, which is the wrong thing to do to somebody's database. So the adapter owns its own durability,
   * exactly as the Postgres driver does, and `skein dev` says so at startup rather than leaving a user to
   * discover it by losing an in-memory adapter's items across a restart. {@link hydrateState} still replays
   * *into* an adapter, because an import is an explicit one-time act rather than a periodic dump.
   */
  snapshotState?(): DevStateSnapshot;
  /**
   * Present only in all-memory mode.
   *
   * Async because a configured `store.adapter` owns the long-term items: they are replayed through it
   * one `put` at a time, since only a driver can bulk-`restore()` and the adapter is not one. Await it.
   */
  hydrateState?(snapshot: DevStateSnapshot): Promise<void>;
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
    // The store-item sweeper, which the durable branch below also starts. The in-memory store already
    // expires items lazily on read once it has the config, but without this nothing ever *deletes*
    // them — a long-lived `skein start` (which takes this path whenever Redis and Postgres are absent)
    // would grow its heap by every expired item it ever wrote.
    const devStoreTtl = resolveStoreTtl(runtime.config.store?.ttl);
    const devDisposers: Disposer[] = [];
    // `store.adapter` has to be honoured on this path too — it is the one `skein dev` takes, so reading
    // it only in the durable branch below would mean the key silently did nothing exactly where a user
    // first tries it. Filled in place for the same reason `serverVersion` is: a reloadable runtime hands
    // out the deps object it keeps, and `resolveDeps` folds `storeItems` into `store` downstream.
    // Guarded, because `resolveStoreAdapter` registers the adapted store's teardown *before* it can
    // refuse a config — so a refusal must still release whatever the store opened on import, and drain
    // the telemetry sinks resolved above. The durable branch below gets this from its own try/catch.
    let devStoreItems;
    try {
      devStoreItems = runtime.config.store?.adapter
        ? await resolveStoreAdapter(runtime.config.store.adapter, {
            configDir,
            importModule,
            maxPageSize: resolveMaxPageSize(),
            ttl: devStoreTtl,
            indexConfigured: runtime.config.store?.index?.embed !== undefined,
            disposers: devDisposers,
          })
        : undefined;
    } catch (error) {
      await flushTelemetry(telemetry);
      for (const dispose of devDisposers) await dispose();
      throw error;
    }
    if (devStoreItems) runtime.deps.storeItems = devStoreItems;
    // Sweep the store the items actually live in. Pointed at the driver's own repo, a `store.ttl` +
    // `store.adapter` deployment would sweep an empty store forever while the adapted one grew.
    if (devStoreTtl) {
      startStoreTtlSweeper(
        devStoreItems ? withStoreItems(runtime.deps.store, devStoreItems) : runtime.deps.store,
        devStoreTtl,
        devDisposers,
      );
    }
    // Filled in place rather than copied, matching how `resolveRuntimeDeps` fills the logger: a
    // reloadable runtime hands out the same deps object it keeps.
    if (serverVersion !== undefined) runtime.deps.serverVersion = serverVersion;
    return {
      deps: runtime.deps,
      cors: runtime.cors,
      reloadGraphs: () => runtime.reloadGraphs(),
      dispose: async () => {
        await flushTelemetry(telemetry);
        for (const dispose of devDisposers) await dispose();
      },
      snapshotState: () => runtime.snapshotState(),
      hydrateState: async (snapshot) => {
        runtime.hydrateState(snapshot);
        // The driver just took the whole snapshot, including its store items — but with an adapter those
        // items are unreachable there, because every reader goes through `storeItems`. Replay them so a
        // restored `.skein/dev-state.json` (or a one-time `langgraph dev` import) actually surfaces.
        // Timestamps are the store's to set on write, so unlike threads and runs nothing is lost.
        if (devStoreItems) {
          for (const [, item] of snapshot.store.items) {
            await devStoreItems.put(item.namespace, item.key, item.value);
          }
        }
      },
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
    // Idempotency retention from langgraph.json `skein.idempotency`. The memory branch above gets
    // this through `loadReloadableInMemoryRuntime`, which reads the same block from its own config —
    // both paths, or the knob would work under `skein start` and do nothing under `skein dev`.
    const idempotency = resolveIdempotency(first.config.skein?.idempotency);
    // Delivery policy from langgraph.json `skein.webhooks`. Absence is *defaults*, not fire-once —
    // a run carrying a `webhook` owes a callback either way. The memory branch above resolves this
    // itself, for the reason that comment gives.
    const webhooks = resolveWebhooks(first.config.skein?.webhooks, {
      warn: (message) => console.warn(message),
    });
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

    // Bring-your-own long-term-memory store (`store.adapter`). Only the memory repo is replaced —
    // assistants, threads, runs, crons and idempotency keep using the driver above — and the
    // substitution happens in `resolveDeps` via `withStoreItems`, so the driver's `maxPageSize` and
    // `durable` survive the composition rather than being dropped by an object spread.
    const storeItems = first.config.store?.adapter
      ? await resolveStoreAdapter(first.config.store.adapter, {
          configDir: first.configDir,
          importModule,
          maxPageSize: resolveMaxPageSize(),
          ttl: storeTtl,
          // Refused rather than silently ignored: `store.index` configures the repo the adapter replaces.
          indexConfigured: first.config.store?.index?.embed !== undefined,
          // So an adapted `PostgresStore` releases its pool on shutdown like every other resource here.
          disposers,
        })
      : undefined;

    // When TTL is configured, sweep expired store items on a background interval (memory or postgres).
    // An adapter that cannot expire items has already failed startup above, so if we reach here with
    // both, the adapted store really can sweep — but the sweeper is pointed at `skeinStore`, whose own
    // `store` repo is the driver's. Point it at the adapter when one is configured, or a `store.ttl`
    // deployment would sweep the wrong store and never expire the rows that actually carry a TTL.
    if (storeTtl) {
      startStoreTtlSweeper(
        storeItems ? withStoreItems(skeinStore, storeItems) : skeinStore,
        storeTtl,
        disposers,
      );
    }

    // `abortChannel` comes with the Redis queue, for the same reason: it is what carries a cancel to
    // the instance executing the run, and in-memory means there is only this one.
    const {
      queue: runQueue,
      bus,
      abortChannel,
      deliveryQueue,
    } = queue === "redis"
      ? connectRedisQueue({
          url: requireEnv("REDIS_URI", "redis"),
          disposers,
          ...(webhooks ? { webhooks } : {}),
        })
      : {
          queue: new MemoryRunQueue(),
          bus: new MemoryRunEventBus(resolveMemoryBusLimits()),
          // No delivery queue on the memory path: the delivery worker polls the outbox instead. That
          // is the development shape — correct, but the schedule dies with the process.
          deliveryQueue: undefined,
        };

    // Telemetry sinks from the `telemetry` block plus environment auto-detection. Left off the deps
    // entirely when nothing is configured, so the engine's `telemetryEnabled` guards stay false.
    const telemetry = await resolveTelemetry({
      config: first.config.telemetry,
      configDir: first.configDir,
      importModule,
    });

    const deps: ProtocolDeps = {
      store: skeinStore,
      ...(storeItems ? { storeItems } : {}),
      // From `langgraph.json`, so always LangGraph graphs — see `langGraphResolver`.
      graphs: langGraphResolver(resolver),
      queue: runQueue,
      bus,
      checkpointer,
      storeBridge: (repo) => new SkeinBaseStore(repo),
      // Throwaway saver for `POST /invoke/:graph_id` — see `ProtocolDeps.ephemeralCheckpointer`.
      ephemeralCheckpointer: () => new MemorySaver(),
      // Clones a checkpoint before it is re-put under another thread id — see `ProtocolDeps.cloneCheckpoint`.
      cloneCheckpoint: cloneLangGraphCheckpoint,
      ...(abortChannel ? { abortChannel } : {}),
      ...(threadExecutionGate ? { threadExecutionGate } : {}),
      // Present only when `checkpointer.ttl` is configured, which is what turns the sweeper on.
      ...(threadTtl ? { threadTtl } : {}),
      // Unlike `threadTtl`, absence is *defaults*, not *off* — `Idempotency-Key` is honoured either way.
      ...(idempotency ? { idempotency } : {}),
      ...(webhooks ? { webhooks } : {}),
      // Present only with Redis. Without it the delivery worker polls the outbox instead — correct,
      // but the schedule dies with the process, which is why `createProtocolRuntime` warns.
      ...(deliveryQueue ? { deliveryQueue } : {}),
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
