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
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
  statementTimeoutMs?: number;
}

/**
 * How long to wait for a pool connection when nothing is configured.
 *
 * Applied as a default rather than left to `pg`, whose default is to wait indefinitely — so a database
 * that has gone away turns every request into a hang with no error and no log line.
 *
 * Thirty seconds, not ten, because `pg` uses this timer for two different waits: the TCP/TLS/startup
 * handshake *and* waiting for a free client when the pool is already at `max`. A tighter bound would
 * turn two ordinary situations into hard failures — a burst of slow-but-working queries against a small
 * `PG_POOL_MAX`, and an autosuspended serverless Postgres (Neon, Supabase) which routinely takes well
 * over ten seconds to wake, on the boot path where `migrate()` connects. Set
 * `PG_CONNECTION_TIMEOUT_MS=0` to restore `pg`'s wait-forever behaviour.
 */
const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;

/** Read a required connection env var, or throw an actionable {@link RuntimeConfigError}. */
export function requireEnv(name: string, driver: string): string {
  const value = process.env[name];
  if (!value) {
    throw new RuntimeConfigError(`The "${driver}" driver requires ${name} to be set.`);
  }
  return value;
}

/**
 * Read an optional integer env var, or `undefined` when unset or blank. Throws on a malformed value.
 *
 * `minimum` differs per setting: most are counts or durations where zero is meaningless, but a couple
 * (`PG_STATEMENT_TIMEOUT_MS`, `SKEIN_REDIS_STREAM_MAXLEN`) use zero to mean "no limit".
 */
function integerFromEnv(name: string, minimum: number): number | undefined {
  const raw = process.env[name];
  // Blank counts as unset — `Number("")` is 0, which for a timeout or a cap would silently mean
  // something rather than nothing.
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new RuntimeConfigError(`${name} must be an integer >= ${minimum} (got "${raw}").`);
  }
  return value;
}

/**
 * Optional Postgres connection tuning from the environment — for fitting a managed database's
 * connection cap, its TLS setup, and how it should behave when it stops responding.
 *
 * `PG_POOL_MAX` caps the pool size (skein opens a second pool for `PostgresSaver`, so budget for both
 * per instance). `DATABASE_SSL_NO_VERIFY=1|true` disables TLS cert verification for a self-signed
 * managed cert over a public URL.
 *
 * `PG_CONNECTION_TIMEOUT_MS` bounds waiting for a pool connection, which `pg` otherwise waits for
 * indefinitely — turning an unreachable database into a hang rather than an error. `PG_IDLE_TIMEOUT_MS`
 * overrides how long an unused client is kept (`pg`'s own default is 10s, not forever), and
 * `PG_STATEMENT_TIMEOUT_MS` bounds a single statement.
 *
 * All three read `0` as "no limit", which for the first two is the escape hatch back to `pg`'s own
 * behaviour and for the third means off.
 */
export function postgresConnectionOptions(): PostgresConnectionOptions {
  const options: PostgresConnectionOptions = {};
  const poolMax = integerFromEnv("PG_POOL_MAX", 1);
  if (poolMax !== undefined) options.poolMax = poolMax;

  // `0` is the escape hatch back to `pg`'s wait-forever behaviour, so zero has to be *accepted* here
  // rather than rejected as out of range — an operator hitting the default's downsides will reach for
  // it, and the sibling `PG_STATEMENT_TIMEOUT_MS` already uses `0` to mean off.
  options.connectionTimeoutMs =
    integerFromEnv("PG_CONNECTION_TIMEOUT_MS", 0) ?? DEFAULT_CONNECTION_TIMEOUT_MS;

  // Zero is meaningful to `pg` here too: keep idle clients indefinitely.
  const idleTimeoutMs = integerFromEnv("PG_IDLE_TIMEOUT_MS", 0);
  if (idleTimeoutMs !== undefined) options.idleTimeoutMs = idleTimeoutMs;

  const statementTimeoutMs = integerFromEnv("PG_STATEMENT_TIMEOUT_MS", 0);
  // Only when asked for. Turning this on by default is deliberately deferred until the query bounds
  // and indexes have shipped and settled — before that it converts slow-but-working queries into
  // errors. `0` is an explicit "no limit" and is passed through as such.
  if (statementTimeoutMs !== undefined && statementTimeoutMs > 0) {
    options.statementTimeoutMs = statementTimeoutMs;
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
  const maxLen = integerFromEnv("SKEIN_REDIS_STREAM_MAXLEN", 0);
  if (maxLen !== undefined) options.streamMaxLen = maxLen;
  const bufferFrames = integerFromEnv("SKEIN_STREAM_BUFFER_FRAMES", 1);
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
