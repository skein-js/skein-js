// Long-term memory: the namespaced key/value store behind `/store`, with optional semantic search
// and TTL. Distinct from the checkpointer, which owns graph state rather than what an agent recalls.

import type { Item, SearchItem } from "../wire/wire.js";

import type { StoreItemFilter } from "./item-filter.js";
import type { StoreNamespaceQuery } from "./namespace-match.js";

export interface StoreSearchQuery {
  /** Restrict to items under this namespace prefix. */
  prefix?: string[];
  /** Natural-language query for semantic search (naive scan in the memory driver). */
  query?: string;
  /**
   * Narrow by the **top-level** keys of each item's `value`. Keys are ANDed.
   *
   * Applied before paging, so a page is a page of *matches*. See {@link matchesItemFilter} for the
   * operator set and the one place it departs from LangGraph.
   */
  filter?: StoreItemFilter;
  limit?: number;
  offset?: number;
}

/**
 * Expiry policy for long-term store items (from `langgraph.json` `store.ttl`). All durations are in
 * minutes. A driver applies `defaultTtl` when a `put` gives no explicit `ttl`, refreshes an item's
 * expiry on read when `refreshOnRead` is set, and a background sweeper (interval `sweepIntervalMinutes`)
 * deletes expired rows via {@link StoreRepo.sweepExpired}.
 */
export interface StoreTtlConfig {
  /** Default item lifetime in minutes when `put` doesn't pass its own `ttl`. */
  defaultTtl?: number;
  /** Extend an item's expiry when it is read. Defaults to true. */
  refreshOnRead?: boolean;
  /** Sweeper cadence in minutes. Defaults to 60. */
  sweepIntervalMinutes?: number;
}

/** Per-`put` options. `ttl` (minutes) overrides the configured `defaultTtl` for this item. */
export interface StorePutOptions {
  ttl?: number;
}

export interface StoreRepo {
  get(namespace: string[], key: string): Promise<Item | null>;
  put(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    options?: StorePutOptions,
  ): Promise<Item>;
  delete(namespace: string[], key: string): Promise<void>;
  search(query: StoreSearchQuery): Promise<SearchItem[]>;
  /**
   * Distinct namespaces, matched and paged per {@link StoreNamespaceQuery}.
   *
   * Takes a query object rather than `(prefix, pagination)` because the positional form could not
   * express a wildcard, a suffix or a depth — and "could not express" is how `["users", "*"]` came to
   * be read as *no prefix at all* and return every namespace in the store.
   */
  listNamespaces(query?: StoreNamespaceQuery): Promise<string[][]>;
  /** Delete every expired item; returns how many were removed. No-op when TTL is unconfigured. */
  sweepExpired(): Promise<number>;
}
