// The long-term memory store. A thin, validated pass-through to `SkeinStore.store` — the driver
// owns behavior (the memory driver does a naive scan; the Postgres driver does pgvector search).

import {
  SkeinHttpError,
  type Item,
  type SearchItem,
  type StoreNamespaceQuery,
  type StorePutOptions,
  type StoreItemWriteOptions,
  type StoreReadOptions,
  type StoreSearchQuery,
} from "@skein-js/core";

import type { ResolvedDeps } from "../deps.js";

export interface StoreService {
  put(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    options?: StorePutOptions,
  ): Promise<Item>;
  putWithOptions?(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    options?: StoreItemWriteOptions,
  ): Promise<Item>;
  get(namespace: string[], key: string, options?: StoreReadOptions): Promise<Item>;
  delete(namespace: string[], key: string): Promise<void>;
  search(query: StoreSearchQuery): Promise<SearchItem[]>;
  listNamespaces(query?: StoreNamespaceQuery): Promise<string[][]>;
}

export function createStoreService(deps: ResolvedDeps): StoreService {
  return {
    put: (namespace, key, value, options) => deps.store.store.put(namespace, key, value, options),

    putWithOptions: (namespace, key, value, options) => {
      const repo = deps.store.store;
      if (repo.putWithOptions) return repo.putWithOptions(namespace, key, value, options);
      if (options?.index !== undefined || options?.ttl === null)
        throw SkeinHttpError.unprocessable(
          "The configured store does not support indexing or explicit no-expiry writes.",
        );
      return repo.put(namespace, key, value, options as StorePutOptions);
    },
    async get(namespace, key, options) {
      if (options?.refreshTtl !== undefined && !deps.store.store.putWithOptions)
        throw SkeinHttpError.unprocessable(
          "The configured store does not support per-operation TTL options.",
        );
      const item = await deps.store.store.get(namespace, key, options);
      if (!item) {
        throw SkeinHttpError.notFound(
          `Store item "${key}" not found in namespace [${namespace.join(", ")}].`,
        );
      }
      return item;
    },

    delete: (namespace, key) => deps.store.store.delete(namespace, key),

    search: (query) => {
      if (query.refreshTtl !== undefined && !deps.store.store.putWithOptions)
        throw SkeinHttpError.unprocessable(
          "The configured store does not support per-operation TTL options.",
        );
      return deps.store.store.search(query);
    },

    listNamespaces: (query) => deps.store.store.listNamespaces(query),
  };
}
