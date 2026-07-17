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
  type ResolvedProtocolRuntime,
  type SkeinRuntimeOptions,
} from "@skein-js/server-kit";

const CONFIG_CACHE_KEY = Symbol.for("skein.nextjs.configRuntimeCache");
const DEPS_CACHE_KEY = Symbol.for("skein.nextjs.depsRuntimeCache");

type RuntimePromise = Promise<ResolvedProtocolRuntime>;

function configCache(): Map<string, RuntimePromise> {
  const store = globalThis as typeof globalThis & {
    [CONFIG_CACHE_KEY]?: Map<string, RuntimePromise>;
  };
  store[CONFIG_CACHE_KEY] ??= new Map();
  return store[CONFIG_CACHE_KEY];
}

function depsCache(): WeakMap<object, RuntimePromise> {
  const store = globalThis as typeof globalThis & {
    [DEPS_CACHE_KEY]?: WeakMap<object, RuntimePromise>;
  };
  store[DEPS_CACHE_KEY] ??= new WeakMap();
  return store[DEPS_CACHE_KEY];
}

/** Resolve once and cache; evict the cached promise if resolution rejects so the next request retries. */
function resolveOnce<K extends object | string>(
  cache: {
    get(key: K): RuntimePromise | undefined;
    set(key: K, value: RuntimePromise): void;
    delete(key: K): void;
  },
  key: K,
  options: SkeinRuntimeOptions,
): RuntimePromise {
  let resolved = cache.get(key);
  if (!resolved) {
    resolved = resolveProtocolRuntime(options).catch((error: unknown) => {
      cache.delete(key); // don't cache a rejection — a transient failure must be retryable
      throw error;
    });
    cache.set(key, resolved);
  }
  return resolved;
}

/** Resolve (once) the runtime for these options, reusing the cached promise across module reloads. */
export function getSkeinRuntime(options: SkeinRuntimeOptions): RuntimePromise {
  if (typeof options.config === "string") {
    return resolveOnce(configCache(), options.config, options);
  }
  return resolveOnce(depsCache(), options.deps, options);
}
