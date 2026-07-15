// The production `ProtocolDeps` assembler. Given a `langgraph.json` and a chosen store/queue
// driver, it wires the concrete drivers and hands back deps ready for any framework adapter's
// `{ deps }` seam (see @skein-js/express's create-express-server / skein-router). This is the one
// place a production driver is selected — the engine itself stays driver-agnostic.
//
// All-memory delegates to @skein-js/express's reloadable in-memory runtime so `skein dev` keeps its
// hot-reload + cross-restart persistence; Postgres/Redis are assembled here around the same
// reroutable graph resolver so graph hot-reload still works against durable storage.

import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { GraphResolver, GraphSchemas, ProtocolDeps } from "@skein-js/agent-protocol";
import {
  loadAuthEngine,
  loadConfig,
  type GraphRegistry,
  type ModuleImporter,
} from "@skein-js/config";
import {
  corsFromHttpConfig,
  loadReloadableInMemoryRuntime,
  type DevStateSnapshot,
} from "@skein-js/express";
import { RedisRunEventBus, RedisRunQueue } from "@skein-js/redis";
import { MemoryRunEventBus, MemoryRunQueue, MemorySkeinStore } from "@skein-js/storage-memory";
import {
  createPostgresPool,
  PostgresSkeinStore,
  type StoreIndexConfig,
} from "@skein-js/storage-postgres";
import type { CorsOptions } from "cors";

import { RuntimeConfigError } from "./errors.js";
import { resolveEmbed } from "./resolve-embed.js";

/** Where protocol resources (assistants/threads/runs/store) and checkpoints are persisted. */
export type StoreDriver = "memory" | "postgres";
/** Where background runs are queued and stream frames are fanned out. */
export type QueueDriver = "memory" | "redis";

export interface BuildRuntimeOptions {
  /** Absolute path to `langgraph.json`. */
  configPath: string;
  /** TS-capable importer (e.g. the CLI's vite loader). Omitted for plain JS/Node resolution. */
  importModule?: ModuleImporter;
  /** `"memory"` (default dev) or `"postgres"` (reads `DATABASE_URL`). */
  store: StoreDriver;
  /** `"memory"` (default dev) or `"redis"` (reads `REDIS_URL`). */
  queue: QueueDriver;
}

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

function requireEnv(name: string, driver: string): string {
  const value = process.env[name];
  if (!value) {
    throw new RuntimeConfigError(`The "${driver}" driver requires ${name} to be set.`);
  }
  return value;
}

/**
 * Optional Postgres connection tuning from the environment — for fitting a managed database's
 * connection cap and its TLS setup. `PG_POOL_MAX` caps the pool size (skein opens a second pool
 * for `PostgresSaver`, so budget for both per instance); `DATABASE_SSL_NO_VERIFY=1|true` disables
 * TLS cert verification for a self-signed managed cert over a public URL.
 */
function postgresConnectionOptions(): { poolMax?: number; sslNoVerify?: boolean } {
  const options: { poolMax?: number; sslNoVerify?: boolean } = {};
  const rawMax = process.env["PG_POOL_MAX"];
  if (rawMax !== undefined && rawMax.trim() !== "") {
    const max = Number(rawMax);
    if (!Number.isInteger(max) || max <= 0) {
      throw new RuntimeConfigError(`PG_POOL_MAX must be a positive integer (got "${rawMax}").`);
    }
    options.poolMax = max;
  }
  const noVerify = process.env["DATABASE_SSL_NO_VERIFY"];
  if (noVerify === "1" || noVerify?.toLowerCase() === "true") options.sslNoVerify = true;
  return options;
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
  index: { embed?: string; dims?: number; fields?: string[] } | undefined,
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
  return { dims: index.dims, fields: index.fields, embed };
}

/** Assemble a {@link SkeinRuntime} for the requested driver combination. */
export async function buildRuntime(options: BuildRuntimeOptions): Promise<SkeinRuntime> {
  const { configPath, importModule, store, queue } = options;

  // All-memory: reuse the express reloadable in-memory runtime verbatim (hot-reload + snapshot).
  if (store === "memory" && queue === "memory") {
    const runtime = await loadReloadableInMemoryRuntime(configPath, importModule);
    return {
      deps: runtime.deps,
      cors: runtime.cors,
      reloadGraphs: () => runtime.reloadGraphs(),
      dispose: async () => {},
      snapshotState: () => runtime.snapshotState(),
      hydrateState: (snapshot) => runtime.hydrateState(snapshot),
    };
  }

  const first = await loadConfig({ configPath, importModule });
  const { resolver, reroute } = reroutableGraphResolver(first.graphs);
  // Track every concrete resource as it is created, so a failure part-way through assembly (a bad
  // migration, a missing REDIS_URL after Postgres already connected) tears down what exists rather
  // than leaking pools/connections. `dispose()` reuses the same list for normal shutdown.
  const disposers: Array<() => Promise<unknown>> = [];
  const disposeAll = async (): Promise<void> => {
    await Promise.allSettled(disposers.map((dispose) => dispose()));
  };

  try {
    const { skeinStore, checkpointer } = await (async () => {
      if (store === "postgres") {
        const databaseUrl = requireEnv("DATABASE_URL", "postgres");
        const index = await resolveStoreIndex(first.config.store?.index, {
          configDir: first.configDir,
          importModule,
        });
        // Both pools hit the same DATABASE_URL, so they must share the same connection tuning —
        // otherwise the saver would ignore PG_POOL_MAX / DATABASE_SSL_NO_VERIFY and fail TLS (or
        // blow the connection cap) even when the store connects fine.
        const connectionOptions = postgresConnectionOptions();
        const pgStore = await PostgresSkeinStore.connect(databaseUrl, {
          ...(index ? { index } : {}),
          ...connectionOptions,
        });
        disposers.push(() => pgStore.close());
        await pgStore.migrate();
        // Build the saver on a pool with the same tuning (fromConnString would ignore it).
        const saver = new PostgresSaver(createPostgresPool(databaseUrl, connectionOptions));
        disposers.push(() => saver.end());
        await saver.setup();
        return { skeinStore: pgStore, checkpointer: saver };
      }
      return { skeinStore: new MemorySkeinStore(), checkpointer: new MemorySaver() };
    })();

    const { runQueue, bus } = (() => {
      if (queue === "redis") {
        const redisUrl = requireEnv("REDIS_URL", "redis");
        const redisQueue = new RedisRunQueue(redisUrl);
        disposers.push(() => redisQueue.dispose());
        const redisBus = new RedisRunEventBus(redisUrl);
        disposers.push(() => redisBus.dispose());
        return { runQueue: redisQueue, bus: redisBus };
      }
      return { runQueue: new MemoryRunQueue(), bus: new MemoryRunEventBus() };
    })();

    const deps: ProtocolDeps = {
      store: skeinStore,
      graphs: resolver,
      queue: runQueue,
      bus,
      checkpointer,
      auth: await loadAuthEngine(first.config.auth, {
        configDir: first.configDir,
        importModule,
      }),
    };

    return {
      deps,
      cors: corsFromHttpConfig(first.config.http),
      reloadGraphs: async () => {
        reroute((await loadConfig({ configPath, importModule })).graphs);
      },
      dispose: disposeAll,
    };
  } catch (error) {
    await disposeAll();
    throw error;
  }
}
