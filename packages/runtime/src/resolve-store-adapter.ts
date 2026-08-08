// Loads `langgraph.json`'s `store.adapter` — a bring-your-own long-term-memory store — into the
// `StoreRepo` that `ProtocolDeps.storeItems` takes.
//
// The fifth use of the pattern `loadAuthEngine` established and `resolveTelemetry`/`resolveEmbed`
// copied: parse a `"path:export"` spec, import through an injectable `ModuleImporter` (so `skein dev`'s
// vite loader can resolve a `.ts` module), and fail with a distinct, actionable error at every step
// rather than surfacing an `undefined is not a function` from inside a request.
//
// It lives here and not in `@skein-js/config` because it must produce a `StoreRepo` via `fromBaseStore`
// from `@skein-js/agent-protocol`, which `config` does not depend on. `resolve-embed.ts` is the closest
// precedent for the same reason.

import { pathToFileURL } from "node:url";

import type { BaseStore } from "@langchain/langgraph";
import { fromBaseStore, supportsStoreTtl } from "@skein-js/agent-protocol";
import { parseGraphSpec, type ModuleImporter } from "@skein-js/config";
import type { StoreRepo, StoreTtlConfig } from "@skein-js/core";

import type { Disposer } from "./drivers.js";
import { RuntimeConfigError } from "./errors.js";

export interface ResolveStoreAdapterOptions {
  /** Directory holding `langgraph.json`, used to resolve the adapter's relative path. */
  configDir: string;
  /**
   * Teardown list to register the adapted store's own shutdown on, when it has one.
   *
   * A `PostgresStore` holds a connection pool and exposes `stop()`; without this, repeated
   * build/dispose cycles leak pools until the database refuses connections, and shutdown falls to the
   * force-exit timer. Optional so a caller that manages the store's lifecycle itself can opt out.
   */
  disposers?: Disposer[];
  /** TS-capable importer (the CLI's vite loader) for a `.ts` adapter module. */
  importModule?: ModuleImporter;
  /** The driver page bound to impose, since `BaseStore` carries none of its own. */
  maxPageSize?: number;
  /**
   * The configured `store.ttl`, if any. Present and non-empty against a store that cannot expire items
   * is a **startup failure**, not a warning — see {@link resolveStoreAdapter}.
   */
  ttl?: StoreTtlConfig | undefined;
  /**
   * Whether `store.index` is configured. An adapter replaces the repo that index would have applied to,
   * so it is refused rather than left to do nothing — see {@link resolveStoreAdapter}.
   */
  indexConfigured?: boolean;
  /** Source rows one call may scan, forwarded to `fromBaseStore`. */
  scanLimit?: number;
}

/** Structurally a LangGraph `BaseStore`: `batch` is its one abstract method, and `StoreRepo` has none. */
function isBaseStore(value: object): value is BaseStore {
  return typeof (value as Partial<BaseStore>).batch === "function";
}

/** The `StoreRepo` methods a hand-written adapter must provide, checked so a typo fails at boot. */
const STORE_REPO_METHODS = [
  "get",
  "put",
  "delete",
  "search",
  "listNamespaces",
  "sweepExpired",
] as const;

/** The first `StoreRepo` method `value` is missing, or `undefined` if it has them all. */
function missingStoreRepoMethod(value: object): string | undefined {
  return STORE_REPO_METHODS.find(
    (method) => typeof (value as Record<string, unknown>)[method] !== "function",
  );
}

/**
 * True when `ttl` asks for expiry at all. An empty `ttl: {}` block asks for nothing and must not fail a
 * boot.
 */
function requestsExpiry(ttl: StoreTtlConfig | undefined): boolean {
  if (!ttl) return false;
  return ttl.defaultTtl !== undefined || ttl.refreshOnRead !== undefined;
}

/**
 * True when `ttl` asks for refresh-on-read, **including by saying nothing**.
 *
 * `StoreTtlConfig.refreshOnRead` defaults to *enabled* — both bundled drivers test `!== false`
 * (`memory-skein-store.ts`, `postgres-skein-store.ts`) — so an omitted value is a request, not an
 * absence. Reading it as `=== true` was wrong in the dangerous direction: `{ default_ttl: 60 }` alone
 * would boot against an adapter and then never refresh, so an item read every minute would still be
 * deleted an hour after its last *write*. Silent data loss, and the docs promised otherwise.
 */
function requestsRefreshOnRead(ttl: StoreTtlConfig | undefined): boolean {
  return ttl?.refreshOnRead !== false;
}

/**
 * Refuse the parts of `store.ttl` an adapted store cannot honour, rather than accepting them silently.
 *
 * `default_ttl` **is** honourable: `fromBaseStore` stamps it onto every write through
 * `PostgresStore`'s 5-argument `put`. `refresh_on_read` is not — `BaseStore.get` has no way to express
 * "extend this item's expiry", so a configured value would simply never happen, and an operator would be
 * left believing active items are kept alive when they are not.
 */
function assertTtlHonourable(
  adapter: string,
  store: BaseStore,
  ttl: StoreTtlConfig | undefined,
): void {
  if (!requestsExpiry(ttl)) return;
  if (!supportsStoreTtl(store)) {
    throw new RuntimeConfigError(
      `store.ttl is configured, but the store.adapter "${adapter}" cannot expire items — TTL is not ` +
        `expressible through a LangGraph \`BaseStore\`, and a store exposing \`sweepExpiredItems()\` ` +
        `(e.g. \`PostgresStore\`) is needed to honour it. Remove store.ttl, or use such a store.`,
    );
  }
  if (requestsRefreshOnRead(ttl)) {
    throw new RuntimeConfigError(
      `store.ttl asks for refresh-on-read (it defaults to enabled), but a store.adapter cannot honour ` +
        `it — LangGraph's \`BaseStore.get\` has no way to extend an item's expiry, so items you read ` +
        `constantly would still be deleted \`default_ttl\` after their last write. Set ` +
        `store.ttl.refresh_on_read to false to accept write-based expiry, or configure refresh-on-read ` +
        `on your own store and remove store.ttl.`,
    );
  }
}

/**
 * Register the adapted store's `stop()` on the runtime's teardown list, when it has one.
 *
 * `BaseStore` declares `start()`/`stop()` for exactly this, and `PostgresStore` uses `stop()` to release
 * its pool. Best-effort and never rethrows: teardown runs from a signal handler whose job is to exit
 * cleanly, matching how `flushTelemetry` treats a failing sink.
 */
function registerStoreShutdown(store: BaseStore, disposers: Disposer[] | undefined): void {
  if (!disposers || typeof store.stop !== "function") return;
  disposers.push(async () => {
    try {
      await store.stop();
    } catch {
      // A store that cannot shut down cleanly must not stop the rest of teardown.
    }
  });
}

/**
 * Refuse `store.index` alongside an adapter, because it configures the repo the adapter replaces.
 *
 * `store.index` builds the pgvector semantic-search config for skein's *own* Postgres driver — an
 * embedder, dimensions, whether to build an HNSW index. An adapted store constructs its own index
 * (`PostgresStore`'s constructor takes one; `InMemoryStore` takes `{ index: { embed, dims } }`), and
 * nothing can inject skein's into it. Left accepted, a configured embedder would resolve, possibly pull an
 * optional provider package, and then have no effect at all on `/store/*` search — the same
 * silent-non-application `store.ttl` refuses.
 */
function assertIndexNotConfigured(adapter: string, indexConfigured: boolean | undefined): void {
  if (!indexConfigured) return;
  throw new RuntimeConfigError(
    `store.index is configured, but the store.adapter "${adapter}" replaces the store it would apply ` +
      `to, so it would have no effect on search. Remove store.index and configure the index on your own ` +
      `store instead (\`PostgresStore\` and \`InMemoryStore\` both take one in their constructor).`,
  );
}

/**
 * A `StoreRepo` adapter implements TTL itself — `put` takes `StorePutOptions.ttl` and `sweepExpired()` is
 * part of the interface — but nothing hands it skein's `store.ttl` config, so `default_ttl` would be
 * accepted and never applied. Refused rather than silently dropped, matching the `BaseStore` branch.
 */
function assertStoreRepoTtlNotConfigured(adapter: string, ttl: StoreTtlConfig | undefined): void {
  if (!requestsExpiry(ttl)) return;
  throw new RuntimeConfigError(
    `store.ttl is configured, but the store.adapter "${adapter}" is a \`StoreRepo\`, which owns its own ` +
      `expiry — skein's store.ttl is not injected into one, so it would have no effect. Remove store.ttl ` +
      `and configure retention inside your adapter, or export a LangGraph \`BaseStore\` instead.`,
  );
}

/**
 * Resolve `store.adapter` to a `StoreRepo`, or throw a `RuntimeConfigError` naming what was wrong.
 *
 * Accepts **either** shape and discriminates structurally on `batch`:
 *
 * - a LangGraph **`BaseStore`** — wrapped with `fromBaseStore`, which re-imposes skein's filter,
 *   namespace and paging semantics rather than forwarding them (see that file for why forwarding is
 *   unsafe, not merely different);
 * - a skein **`StoreRepo`** — used directly, after checking it has every method, so a mis-shaped export
 *   fails at boot instead of at the first request that reaches the missing one.
 *
 * **A configured `store.ttl` against a store that cannot expire items fails startup.** The alternative
 * is accepting the config and discarding it, which leaves an operator believing a retention policy is in
 * force — the same reasoning that makes `fromBaseStore` refuse a per-item `ttl`. TTL is invisible through
 * `BaseStore`, so the capability is detected by `sweepExpiredItems` (how `PostgresStore` exposes it).
 */
export async function resolveStoreAdapter(
  adapter: string,
  options: ResolveStoreAdapterOptions,
): Promise<StoreRepo> {
  const { sourceFile, exportSymbol } = parseGraphSpec(adapter, options.configDir);
  const importer: ModuleImporter =
    options.importModule ??
    ((file) => import(pathToFileURL(file).href) as Promise<Record<string, unknown>>);

  let module: Record<string, unknown>;
  try {
    module = await importer(sourceFile);
  } catch (cause) {
    throw new RuntimeConfigError(
      `store.adapter "${adapter}" — failed to import module "${sourceFile}".`,
      { cause },
    );
  }

  const exported = module[exportSymbol];
  if (exported == null) {
    throw new RuntimeConfigError(
      `store.adapter "${adapter}" — module "${sourceFile}" has no export "${exportSymbol}".`,
    );
  }
  if (typeof exported !== "object") {
    throw new RuntimeConfigError(
      `store.adapter "${adapter}" — export "${exportSymbol}" is ${typeof exported}, expected a ` +
        `LangGraph \`BaseStore\` or a skein \`StoreRepo\`. Export the store itself, not a factory.`,
    );
  }

  if (isBaseStore(exported)) {
    // Registered *before* any refusal below can throw: a store that opened a pool on import must still be
    // torn down when the config it was imported for turns out to be unusable. `store.index` is checked
    // after this for the same reason — it used to run first and leak the pool on a refused boot.
    registerStoreShutdown(exported, options.disposers);
    assertIndexNotConfigured(adapter, options.indexConfigured);
    assertTtlHonourable(adapter, exported, options.ttl);
    // `BaseStore` declares `start()` for initialization. Called here so a store needing it fails at boot
    // with this error rather than at whichever request first touches an uninitialized connection —
    // idempotent on both bundled LangGraph stores, and skipped when the store does not declare it.
    if (typeof exported.start === "function") {
      try {
        await exported.start();
      } catch (cause) {
        throw new RuntimeConfigError(
          `store.adapter "${adapter}" — the store's \`start()\` failed. It is imported ready to use, so ` +
            `either initialize it in your module (\`await store.setup()\`) or fix the failure below.`,
          { cause },
        );
      }
    }
    return fromBaseStore(exported, {
      ...(options.maxPageSize !== undefined ? { maxPageSize: options.maxPageSize } : {}),
      ...(options.scanLimit !== undefined ? { scanLimit: options.scanLimit } : {}),
      // Threaded through, or `store.ttl.default_ttl` would pass the check above and then reach no write.
      ...(options.ttl?.defaultTtl !== undefined ? { defaultTtl: options.ttl.defaultTtl } : {}),
    });
  }

  const missing = missingStoreRepoMethod(exported);
  if (missing) {
    throw new RuntimeConfigError(
      `store.adapter "${adapter}" — export "${exportSymbol}" is neither a LangGraph \`BaseStore\` ` +
        `(no \`batch\` method) nor a complete skein \`StoreRepo\` (no \`${missing}\` method).`,
    );
  }
  assertIndexNotConfigured(adapter, options.indexConfigured);
  assertStoreRepoTtlNotConfigured(adapter, options.ttl);
  return exported as StoreRepo;
}
