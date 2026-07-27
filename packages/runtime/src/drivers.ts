// Concrete Postgres/Redis driver assembly, factored out of build-runtime so both `buildRuntime`
// (langgraph.json-driven) and `embedPostgresGraphs` (graphs-in-code) share one implementation and one
// ordered teardown. Each connect helper pushes its disposer(s) onto the caller's list in creation
// order, so a partial-assembly failure tears down exactly what already exists — the caller reuses the
// same list for normal shutdown. Types are derived from `ProtocolDeps` and the store's public option
// shape, so this module (and runtime's dependency set) needs no direct `@skein-js/core` import.
// See build-runtime.ts and embed-postgres-graphs.ts.

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { ProtocolDeps } from "@skein-js/agent-protocol";
import { RedisRunEventBus, RedisRunQueue, type RedisRunEventBusOptions } from "@skein-js/redis";
import {
  createPostgresPool,
  PostgresSkeinStore,
  type PostgresSkeinStoreOptions,
  type StoreIndexConfig,
} from "@skein-js/storage-postgres";

import { RuntimeConfigError } from "./errors.js";

/** A teardown thunk. Pushed in creation order; run failure-tolerantly via `Promise.allSettled`. */
export type Disposer = () => Promise<unknown>;

/**
 * Run every tracked disposer, tolerating individual failures (order-independent teardown) — the shared
 * shutdown/rollback path for both `buildRuntime` and `embedPostgresGraphs`, so a disposer that throws
 * never blocks the others.
 */
export async function runDisposers(disposers: Disposer[]): Promise<void> {
  await Promise.allSettled(disposers.map((dispose) => dispose()));
}

/** Store-item TTL policy — derived from the store's public option so runtime needn't depend on core. */
export type StoreTtl = NonNullable<PostgresSkeinStoreOptions["ttl"]>;

/** pg connection tuning, shared by the store pool and the checkpointer pool against one URL. */
export interface PostgresConnectionOptions {
  poolMax?: number;
  sslNoVerify?: boolean;
}

/** Read a required connection env var, or throw an actionable {@link RuntimeConfigError}. */
export function requireEnv(name: string, driver: string): string {
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
export function postgresConnectionOptions(): PostgresConnectionOptions {
  const options: PostgresConnectionOptions = {};
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
 * Connect the Postgres `SkeinStore` (+ migrate) and the `PostgresSaver` checkpointer (+ setup) against
 * one URL, sharing connection tuning across both pools — the saver's `fromConnString` would ignore the
 * tuning, so it is built on an explicit `createPostgresPool`. Pushes `store.close()` then `saver.end()`
 * onto `disposers` in that order, so teardown releases both pools even on a partial-assembly failure.
 */
export async function connectPostgresStore(args: {
  url: string;
  index?: StoreIndexConfig;
  ttl?: StoreTtl;
  connectionOptions: PostgresConnectionOptions;
  disposers: Disposer[];
}): Promise<Pick<ProtocolDeps, "store" | "checkpointer">> {
  const { url, index, ttl, connectionOptions, disposers } = args;
  const store = await PostgresSkeinStore.connect(url, {
    ...(index ? { index } : {}),
    ...(ttl ? { ttl } : {}),
    ...connectionOptions,
  });
  disposers.push(() => store.close());
  await store.migrate();
  const checkpointer = new PostgresSaver(createPostgresPool(url, connectionOptions));
  disposers.push(() => checkpointer.end());
  await checkpointer.setup();
  return { store, checkpointer };
}

/** Read a positive-integer (or zero, where that is meaningful) setting from the environment. */
function redisCountFromEnv(name: string, allowZero = false): number | undefined {
  const raw = process.env[name];
  // Blank counts as unset — `Number("")` is 0, which would otherwise silently mean something.
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  const floor = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < floor) {
    throw new RuntimeConfigError(
      `${name} must be an integer >= ${floor} (got "${raw}").`, //
    );
  }
  return value;
}

/**
 * Optional Redis event-bus tuning from the environment.
 *
 * `SKEIN_REDIS_STREAM_MAXLEN` bounds what one run's frame stream costs in Redis — the retention TTL
 * alone does not, since a chatty graph can produce an enormous stream well inside an hour. `0`
 * disables trimming. `SKEIN_STREAM_BUFFER_FRAMES` bounds what a single slow SSE subscriber may queue
 * in this process before its stream is ended and it is left to reconnect.
 */
export function redisEventBusOptions(): RedisRunEventBusOptions {
  const options: RedisRunEventBusOptions = {};
  const maxLen = redisCountFromEnv("SKEIN_REDIS_STREAM_MAXLEN", true);
  if (maxLen !== undefined) options.streamMaxLen = maxLen;
  const bufferFrames = redisCountFromEnv("SKEIN_STREAM_BUFFER_FRAMES");
  if (bufferFrames !== undefined) options.subscriberBufferFrames = bufferFrames;
  return options;
}

/** Connect the Redis run queue + event bus against one URL. Pushes queue then bus disposers. */
export function connectRedisQueue(args: {
  url: string;
  disposers: Disposer[];
}): Pick<ProtocolDeps, "queue" | "bus"> {
  const { url, disposers } = args;
  const queue = new RedisRunQueue(url);
  disposers.push(() => queue.dispose());
  const bus = new RedisRunEventBus(url, redisEventBusOptions());
  disposers.push(() => bus.dispose());
  return { queue, bus };
}

/**
 * Sweep expired store items on a background interval (default 60 min) for any store — memory or
 * Postgres. `unref()` so the timer never keeps the process alive; the pushed disposer stops it on
 * shutdown. The sweep is caught so a transient DB error is logged, never surfaced as an unhandled
 * rejection that could take the process down.
 */
export function startStoreTtlSweeper(
  store: ProtocolDeps["store"],
  ttl: StoreTtl,
  disposers: Disposer[],
): void {
  const everyMs = (ttl.sweepIntervalMinutes ?? 60) * 60_000;
  const sweeper = setInterval(() => {
    store.store.sweepExpired().catch((error) => {
      console.error("skein: store TTL sweep failed", error);
    });
  }, everyMs);
  sweeper.unref();
  disposers.push(async () => clearInterval(sweeper));
}
