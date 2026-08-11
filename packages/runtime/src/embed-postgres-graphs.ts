// The config-free, durable counterpart to server-kit's `embedInMemoryGraphs`: bring a graph (or a map
// of them) you already hold in code and get a `ProtocolDeps` backed by Postgres (the store + a
// `PostgresSaver` checkpointer) and, when a Redis URL is present, a Redis run queue + event bus — a
// durable, horizontally-scalable deployment in one line, no `langgraph.json` and no CLI. Because it
// owns pools/connections (unlike the in-memory helper's in-process drivers), it returns a `dispose()`.
//
// The concrete driver assembly + ordered teardown is shared with `buildRuntime` via `./drivers.js`;
// the graph-map/resolver normalization is shared with `embedInMemoryGraphs` via server-kit. See
// docs/embedding.md.

import { MemorySaver } from "@langchain/langgraph";
import { withStoreItems } from "@skein-js/agent-protocol";
import type { GraphResolver, ProtocolDeps } from "@skein-js/agent-protocol";
import { cloneLangGraphCheckpoint, SkeinBaseStore } from "@skein-js/langgraph";
import {
  normalizeEmbeddableGraphs,
  resolveMaxPageSize,
  resolveRunConcurrency,
  resolveMemoryBusLimits,
  type EmbeddableGraph,
} from "@skein-js/server-kit";
import { MemoryRunEventBus, MemoryRunQueue } from "@skein-js/storage-memory";
import type { StoreIndexConfig } from "@skein-js/storage-postgres";

import {
  connectPostgresStore,
  connectRedisQueue,
  postgresConnectionOptions,
  requireEnv,
  runDisposers,
  startStoreTtlSweeper,
  type Disposer,
  type StoreTtl,
  type ThreadTtl,
} from "./drivers.js";
import { RuntimeConfigError } from "./errors.js";

/** Options for {@link embedPostgresGraphs} — connection strings, semantic search, TTL, and overrides. */
export interface EmbedPostgresGraphsOptions {
  /** Postgres connection string. Defaults to `process.env.POSTGRES_URI`; throws if neither is set. */
  postgresUri?: string;
  /**
   * Redis connection string. Defaults to `process.env.REDIS_URI`. When **absent**, the run queue and
   * event bus fall back to in-memory — a single durable instance: state survives a restart, but the
   * run queue is process-local and streaming is not fanned across instances, so it is **not
   * horizontally scalable**. Set a Redis URL to run more than one instance.
   */
  redisUri?: string;
  /**
   * pgvector semantic-search config for the long-term store — a resolved embedder (`dims` + `embed`).
   * Omitted → store search falls back to naive text matching.
   */
  index?: StoreIndexConfig;
  /** Store-item TTL/expiry policy (with a background sweep). Omitted → items never expire. */
  ttl?: StoreTtl;
  /**
   * Thread TTL — a default lifetime and sweep cadence for threads, the in-code equivalent of
   * `checkpointer.ttl`. Omitted → threads take no default expiry, though a per-thread `ttl` on
   * `POST /threads` is still honoured and still collected.
   */
  threadTtl?: ThreadTtl;
  /** Max connections per pool (skein opens two — store + saver). Defaults to env `PG_POOL_MAX`. */
  poolMax?: number;
  /** Disable TLS cert verification (self-signed managed cert). Defaults to env `DATABASE_SSL_NO_VERIFY`. */
  sslNoVerify?: boolean;
  /**
   * How long to wait for a pool connection before failing (ms). Defaults to env
   * `PG_CONNECTION_TIMEOUT_MS`, else 30s — `pg` itself waits forever, which turns an unreachable
   * database into a hang rather than an error.
   */
  connectionTimeoutMs?: number;
  /** How long an unused pooled client is kept (ms). Defaults to env `PG_IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number;
  /**
   * Server-side ceiling on one statement (ms). Defaults to env `PG_STATEMENT_TIMEOUT_MS`, else 30s.
   * `0` disables it. Schema DDL is exempt.
   */
  statementTimeoutMs?: number;
  /**
   * The largest page any store list/search returns, including when the caller asks for no limit.
   * Defaults to env `SKEIN_MAX_PAGE_SIZE`, else 1000 — a bound on how much one request can materialize,
   * not a correctness setting (the wire schemas cap a client-supplied `limit` at 1000 regardless).
   */
  maxPageSize?: number;
  /**
   * Replace or add any NON-driver dep — `auth`, `logger`, `clock`, `logRunActivity`, `runTimeoutMs`,
   * `webhookDispatcher`, `webhooks`. The drivers (`store`/`queue`/`bus`/`checkpointer`) and `graphs`
   * are owned by this helper and excluded, so a stray override can't void the durable wiring or the
   * graph source.
   *
   * This helper reads no `langgraph.json`, so `webhooks` (the delivery retry policy) arrives here
   * rather than from a config block. Outbound callbacks are durable either way: that comes from the
   * Postgres store's `deliveries` repo, which this helper always wires.
   */
  overrides?: Omit<Partial<ProtocolDeps>, "graphs" | "store" | "queue" | "bus" | "checkpointer">;
}

/** The result of {@link embedPostgresGraphs}: the assembled deps and a `dispose()` for the pools it owns. */
export interface EmbeddedPostgresRuntime {
  /** Assembled deps for any adapter's `{ deps }` seam. */
  deps: ProtocolDeps;
  /** Tear down the Postgres pools + any Redis connections + the TTL sweeper. Call on shutdown. */
  dispose(): Promise<void>;
}

/**
 * Build a durable `ProtocolDeps` around graphs you already hold in code — Postgres store +
 * `PostgresSaver`, plus Redis queue/bus when a Redis URL is configured — and a `dispose()` to release
 * the pools/connections it opens. Pass a map of compiled graphs (or factories), or a ready
 * {@link GraphResolver}; hand the result's `deps` to any adapter's `{ deps }` seam:
 *
 * ```ts
 * import { embedPostgresGraphs } from "@skein-js/runtime";
 * import { createExpressServer } from "@skein-js/express";
 *
 * const { deps, dispose } = await embedPostgresGraphs({ agent: graph }); // reads POSTGRES_URI / REDIS_URI
 * const server = await createExpressServer({ deps });
 * await server.listen(2024);
 * // …on shutdown:
 * await dispose();
 * ```
 *
 * Postgres is required (`POSTGRES_URI` or `options.postgresUri`). Redis is optional — see
 * {@link EmbedPostgresGraphsOptions.redisUri} for the single-instance caveat when it's omitted.
 */
export async function embedPostgresGraphs(
  graphs: GraphResolver | Record<string, EmbeddableGraph>,
  options: EmbedPostgresGraphsOptions = {},
): Promise<EmbeddedPostgresRuntime> {
  // Track every concrete resource as it is created, so a failure part-way through assembly tears down
  // what exists rather than leaking pools/connections. `dispose()` reuses the same list for shutdown.
  const disposers: Disposer[] = [];
  const dispose = (): Promise<void> => runDisposers(disposers);

  try {
    // An explicit poolMax is validated the same way the env path validates PG_POOL_MAX, so a
    // non-positive value fails loudly here instead of silently producing a broken/hanging pool.
    if (
      options.poolMax !== undefined &&
      (!Number.isInteger(options.poolMax) || options.poolMax <= 0)
    ) {
      throw new RuntimeConfigError(`poolMax must be an integer >= 1 (got ${options.poolMax}).`);
    }
    // Same treatment for the timeouts, so the in-code path and the environment path agree. Left
    // unchecked these fail in ways that are hard to trace: `pg` reads `0` as falsy and waits forever,
    // a negative `connectionTimeoutMs` makes `setTimeout` fire immediately so *every* connect
    // "times out", and a fractional statement timeout reaches Postgres as an invalid value.
    for (const [name, value] of [
      ["connectionTimeoutMs", options.connectionTimeoutMs],
      ["idleTimeoutMs", options.idleTimeoutMs],
      ["statementTimeoutMs", options.statementTimeoutMs],
    ] as const) {
      // Zero is legal for all three — it means "no limit" / "pg default" — so the floor is 0, not 1.
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        throw new RuntimeConfigError(`${name} must be an integer >= 0 (got ${value}).`);
      }
    }
    // Explicit options win over env-derived tuning; the env is still read + validated (a bad
    // PG_POOL_MAX throws) so both sources agree, matching `buildRuntime`.
    const connectionOptions = {
      ...postgresConnectionOptions(),
      ...(options.poolMax !== undefined ? { poolMax: options.poolMax } : {}),
      ...(options.sslNoVerify !== undefined ? { sslNoVerify: options.sslNoVerify } : {}),
      ...(options.connectionTimeoutMs !== undefined
        ? { connectionTimeoutMs: options.connectionTimeoutMs }
        : {}),
      ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
      ...(options.statementTimeoutMs !== undefined
        ? { statementTimeoutMs: options.statementTimeoutMs }
        : {}),
    };

    const { store, checkpointer } = await connectPostgresStore({
      // A blank explicit URI is treated as "not provided" so it falls through to `requireEnv` and gets
      // the actionable RuntimeConfigError, rather than an opaque `pg` error from connecting to "".
      url: blankToUndefined(options.postgresUri) ?? requireEnv("POSTGRES_URI", "postgres"),
      index: options.index,
      ttl: options.ttl,
      threadTtl: options.threadTtl,
      connectionOptions,
      // Validates an explicit value the same way the env path validates SKEIN_MAX_PAGE_SIZE.
      maxPageSize: resolveMaxPageSize(options.maxPageSize),
      runConcurrency: resolveRunConcurrency(),
      disposers,
    });
    // Pointed at whichever store the items actually live in. `overrides.storeItems` is a bring-your-own
    // long-term store (docs/storage.md), and aimed at the driver's own repo the sweeper would tidy an
    // empty table forever while the adapted one grew — the same mistake `buildRuntime` avoids.
    if (options.ttl) {
      const swept = options.overrides?.storeItems
        ? withStoreItems(store, options.overrides.storeItems)
        : store;
      startStoreTtlSweeper(swept, options.ttl, disposers);
    }

    // Redis is optional; a blank URI counts as absent. When it is, warn — a silent downgrade to a
    // process-local queue is a footgun for a helper people reach for to deploy (see the redisUri doc).
    const redisUrl =
      blankToUndefined(options.redisUri) ?? blankToUndefined(process.env["REDIS_URI"]);
    if (!redisUrl) {
      console.warn(
        "skein: embedPostgresGraphs has no Redis URL (redisUri / REDIS_URI) — using an in-memory run " +
          "queue + event bus. State is durable in Postgres, but this is a single instance: the queue is " +
          "process-local and streaming isn't fanned across instances. Set a Redis URL to scale out.",
      );
    }
    // No Redis means the in-memory bus in production. Bound it from the environment rather than
    // leaving it at the constructor defaults — this is the path a Postgres-only deployment runs on,
    // and it is the one that has to survive weeks of uptime.
    const { queue, bus, deliveryQueue } = redisUrl
      ? connectRedisQueue({
          url: redisUrl,
          disposers,
          ...(options.overrides?.webhooks ? { webhooks: options.overrides.webhooks } : {}),
        })
      : {
          queue: new MemoryRunQueue(),
          bus: new MemoryRunEventBus(resolveMemoryBusLimits()),
          // Without Redis there is nowhere durable to hold a retry, so the delivery worker polls the
          // outbox instead. Callbacks are still never *lost* — the row is written in the run's
          // transaction — but a retry still waiting when the process exits does not survive it.
          deliveryQueue: undefined,
        };

    const deps: ProtocolDeps = {
      store,
      graphs: normalizeEmbeddableGraphs(graphs),
      queue,
      bus,
      checkpointer,
      storeBridge: (repo) => new SkeinBaseStore(repo),
      // Throwaway saver for `POST /invoke/:graph_id` — see `ProtocolDeps.ephemeralCheckpointer`.
      ephemeralCheckpointer: () => new MemorySaver(),
      // Clones a checkpoint before it is re-put under another thread id — see `ProtocolDeps.cloneCheckpoint`.
      cloneCheckpoint: cloneLangGraphCheckpoint,
      // Carried so the runtime's sweeper picks up the configured cadence; the sweeper itself runs
      // either way, because a per-thread `ttl` needs collecting with or without a default.
      ...(options.threadTtl ? { threadTtl: options.threadTtl } : {}),
      ...(deliveryQueue ? { deliveryQueue } : {}),
      ...options.overrides, // spread LAST, mirroring embedInMemoryGraphs
    };
    return { deps, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Treat an unset or blank/whitespace-only connection string as "not provided". */
function blankToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value : undefined;
}
