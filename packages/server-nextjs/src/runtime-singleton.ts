// Memoize the resolved runtime on `globalThis` so Next.js's module re-evaluation (dev HMR, and each
// serverless invocation reusing a warm Node process) does not spawn a second background worker or a
// second set of in-memory drivers. The `{ config }` path is keyed by config path; the `{ deps }` path
// is keyed by the deps object's identity (a `WeakMap`), so two handlers with *different* injected deps
// get distinct runtimes instead of colliding on one shared slot. A rejected resolution is evicted so a
// transient first-request failure can be retried rather than poisoning the cache permanently.
//
// Caveat: this needs a long-lived Node process. It is fine on `next start` with `runtime = "nodejs"`;
// serverless/edge deploys that don't keep a process warm need the Redis queue + Postgres store.

import {
  resolveProtocolRuntime,
  resolveRuntimeDeps,
  type ResolvedProtocolRuntime,
  type ResolvedRuntimeDeps,
  type SkeinRuntimeOptions,
} from "@skein-js/server-kit";

const CONFIG_CACHE_KEY = Symbol.for("skein.nextjs.configRuntimeCache");
const DEPS_CACHE_KEY = Symbol.for("skein.nextjs.depsRuntimeCache");
// The invoke surface caches separately: it resolves only deps (no assistants, no worker), so sharing
// a slot with the full runtime would make whichever handler ran first decide what the other got.
const CONFIG_INVOKE_CACHE_KEY = Symbol.for("skein.nextjs.configInvokeCache");
const DEPS_INVOKE_CACHE_KEY = Symbol.for("skein.nextjs.depsInvokeCache");

type Cached<T> = Promise<T>;

function globalMap<T>(key: symbol): Map<string, Cached<T>> {
  const store = globalThis as typeof globalThis &
    Record<symbol, Map<string, Cached<T>> | undefined>;
  store[key] ??= new Map<string, Cached<T>>();
  return store[key] as Map<string, Cached<T>>;
}

function globalWeakMap<T>(key: symbol): WeakMap<object, Cached<T>> {
  const store = globalThis as typeof globalThis &
    Record<symbol, WeakMap<object, Cached<T>> | undefined>;
  store[key] ??= new WeakMap<object, Cached<T>>();
  return store[key] as WeakMap<object, Cached<T>>;
}

/** Resolve once and cache; evict the cached promise if resolution rejects so the next request retries. */
function resolveOnce<K extends object | string, T>(
  cache: {
    get(key: K): Cached<T> | undefined;
    set(key: K, value: Cached<T>): void;
    delete(key: K): void;
  },
  key: K,
  resolve: () => Promise<T>,
): Cached<T> {
  let resolved = cache.get(key);
  if (!resolved) {
    resolved = resolve().catch((error: unknown) => {
      cache.delete(key); // don't cache a rejection — a transient failure must be retryable
      throw error;
    });
    cache.set(key, resolved);
  }
  return resolved;
}

/**
 * Memoize a resolution against these options: keyed by config path for the `{ config }` form, and by
 * the deps object's identity for `{ deps }`, so two handlers with different injected deps get
 * distinct entries rather than colliding on one shared slot.
 */
function memoizeByOptions<T>(
  options: SkeinRuntimeOptions,
  configKey: symbol,
  depsKey: symbol,
  resolve: () => Promise<T>,
): Cached<T> {
  if (typeof options.config === "string") {
    return resolveOnce(globalMap<T>(configKey), options.config, resolve);
  }
  return resolveOnce(globalWeakMap<T>(depsKey), options.deps, resolve);
}

/** Resolve (once) the runtime for these options, reusing the cached promise across module reloads. */
export function getSkeinRuntime(options: SkeinRuntimeOptions): Promise<ResolvedProtocolRuntime> {
  return memoizeByOptions(options, CONFIG_CACHE_KEY, DEPS_CACHE_KEY, () =>
    resolveProtocolRuntime(options),
  );
}

/**
 * Resolve (once) just the deps for these options — what the simplified invoke surface needs, since it
 * seeds no assistants and starts no background run worker.
 */
export function getSkeinInvokeDeps(options: SkeinRuntimeOptions): Promise<ResolvedRuntimeDeps> {
  return memoizeByOptions(options, CONFIG_INVOKE_CACHE_KEY, DEPS_INVOKE_CACHE_KEY, () =>
    resolveRuntimeDeps(options),
  );
}
