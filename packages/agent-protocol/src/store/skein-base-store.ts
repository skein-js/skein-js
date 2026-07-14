// Bridges skein's `SkeinStore.store` (a `StoreRepo`) into a LangGraph `BaseStore`, so graph nodes
// can reach long-term memory the LangGraph-native way — `getStore()` / the `store` arg / `config.store`
// — instead of only over the `/store/items` HTTP endpoints. The run engine attaches one of these to
// every graph run (see `resolveGraph`), mirroring how it attaches the checkpointer. This is also what
// makes skein a faithful drop-in: graphs written for LangGraph Platform, which auto-provides a store,
// keep working unchanged.
//
// `StoreRepo` and `BaseStore` line up almost exactly; the only real translation is the item timestamp
// shape — the wire `Item` carries `createdAt`/`updatedAt` as ISO strings, LangGraph's `Item` as `Date`.

import {
  BaseStore,
  type GetOperation,
  type Item as LangGraphItem,
  type ListNamespacesOperation,
  type Operation,
  type OperationResults,
  type PutOperation,
  type SearchOperation,
} from "@langchain/langgraph";
import type { Item, SearchItem, StoreRepo, StoreSearchQuery } from "@skein-js/core";

// `@langchain/langgraph` re-exports `Item` but not `SearchItem`; it's structurally an item + score.
type LangGraphSearchItem = LangGraphItem & { score?: number };

/** Wire `Item` (ISO-string timestamps) → LangGraph `Item` (`Date` timestamps). */
function toLangGraphItem(item: Item): LangGraphItem {
  return {
    namespace: item.namespace,
    key: item.key,
    value: item.value,
    createdAt: new Date(item.createdAt),
    updatedAt: new Date(item.updatedAt),
  };
}

/** Wire `SearchItem` → LangGraph `SearchItem`, carrying the optional relevance score through. */
function toLangGraphSearchItem(item: SearchItem): LangGraphSearchItem {
  const base = toLangGraphItem(item);
  return item.score === undefined ? base : { ...base, score: item.score };
}

/** The prefix a `listNamespaces` batch op restricts to, if it carries a single "prefix" condition. */
function prefixFromListOperation(operation: ListNamespacesOperation): string[] | undefined {
  const prefixCondition = operation.matchConditions?.find(
    (condition) => condition.matchType === "prefix",
  );
  if (!prefixCondition) return undefined;
  // A concrete prefix only; wildcards (`*`) aren't expressible against `StoreRepo.listNamespaces`.
  return prefixCondition.path.every((segment) => segment !== "*")
    ? (prefixCondition.path as string[])
    : undefined;
}

/**
 * A LangGraph `BaseStore` backed by a skein `StoreRepo`. All behavior — naive scan in the memory
 * driver, pgvector semantic search in Postgres — comes from the underlying repo; this class only
 * adapts the method shapes.
 *
 * Not adapted (the repo has no equivalent, matching the HTTP surface): `search`'s `filter`, the
 * per-`put` `index` override (indexing is configured once via `langgraph.json`'s `store.index`), and
 * `listNamespaces`' `suffix`/`maxDepth`. These are accepted and ignored rather than throwing.
 */
export class SkeinBaseStore extends BaseStore {
  constructor(private readonly repo: StoreRepo) {
    super();
  }

  override async get(namespace: string[], key: string): Promise<LangGraphItem | null> {
    const item = await this.repo.get(namespace, key);
    return item ? toLangGraphItem(item) : null;
  }

  override async put(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    await this.repo.put(namespace, key, value);
  }

  override async delete(namespace: string[], key: string): Promise<void> {
    await this.repo.delete(namespace, key);
  }

  override async search(
    namespacePrefix: string[],
    options?: { filter?: Record<string, unknown>; limit?: number; offset?: number; query?: string },
  ): Promise<LangGraphSearchItem[]> {
    // Match LangGraph BaseStore's contract: search defaults to at most 10 results. (The base class
    // injects this before dispatching to batch; we override the convenience methods, so apply it
    // here.) Without it a no-limit search would return every item under the prefix.
    const query: StoreSearchQuery = { prefix: namespacePrefix, limit: options?.limit ?? 10 };
    if (options?.query !== undefined) query.query = options.query;
    if (options?.offset !== undefined) query.offset = options.offset;
    const items = await this.repo.search(query);
    return items.map(toLangGraphSearchItem);
  }

  override async listNamespaces(options?: {
    prefix?: string[];
    suffix?: string[];
    maxDepth?: number;
    limit?: number;
    offset?: number;
  }): Promise<string[][]> {
    // `StoreRepo.listNamespaces` has no pagination, so apply `offset`/`limit` here — otherwise
    // offset paging never advances. (`suffix`/`maxDepth` remain unsupported, per the class doc.)
    const all = await this.repo.listNamespaces(options?.prefix);
    const offset = options?.offset ?? 0;
    const end = options?.limit === undefined ? undefined : offset + options.limit;
    return all.slice(offset, end);
  }

  // BaseStore's only abstract method. The convenience methods above are overridden to hit the repo
  // directly, so this dispatcher can safely call them without recursing back through `batch`.
  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results = await Promise.all(operations.map((operation) => this.runOperation(operation)));
    return results as OperationResults<Op>;
  }

  private runOperation(
    operation: Operation,
  ): Promise<LangGraphItem | null | LangGraphSearchItem[] | string[][] | void> {
    if ("namespacePrefix" in operation) {
      const search = operation as SearchOperation;
      // `search()` reads only query/limit/offset (filter is intentionally unsupported), so the
      // SearchOperation can be passed straight through as the options bag.
      return this.search(search.namespacePrefix, search);
    }
    if ("value" in operation) {
      const put = operation as PutOperation;
      // A null value is a delete, per LangGraph's PutOperation contract.
      return put.value === null
        ? this.delete(put.namespace, put.key)
        : this.put(put.namespace, put.key, put.value);
    }
    if ("key" in operation) {
      const get = operation as GetOperation;
      return this.get(get.namespace, get.key);
    }
    return this.listNamespaces({ prefix: prefixFromListOperation(operation) });
  }
}
