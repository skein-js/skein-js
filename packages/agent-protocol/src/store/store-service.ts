// The long-term memory store. A thin, validated pass-through to `SkeinStore.store` — the driver
// owns behavior (the memory driver does a naive scan; the Postgres driver does pgvector search).

import { SkeinHttpError, type Item, type SearchItem, type StoreSearchQuery } from "@skein-js/core";

import type { ResolvedDeps } from "../deps.js";

export interface StoreService {
  put(namespace: string[], key: string, value: Record<string, unknown>): Promise<Item>;
  get(namespace: string[], key: string): Promise<Item>;
  delete(namespace: string[], key: string): Promise<void>;
  search(query: StoreSearchQuery): Promise<SearchItem[]>;
  listNamespaces(prefix?: string[]): Promise<string[][]>;
}

export function createStoreService(deps: ResolvedDeps): StoreService {
  return {
    put: (namespace, key, value) => deps.store.store.put(namespace, key, value),

    async get(namespace, key) {
      const item = await deps.store.store.get(namespace, key);
      if (!item) {
        throw SkeinHttpError.notFound(
          `Store item "${key}" not found in namespace [${namespace.join(", ")}].`,
        );
      }
      return item;
    },

    delete: (namespace, key) => deps.store.store.delete(namespace, key),

    search: (query) => deps.store.store.search(query),

    listNamespaces: (prefix) => deps.store.store.listNamespaces(prefix),
  };
}
