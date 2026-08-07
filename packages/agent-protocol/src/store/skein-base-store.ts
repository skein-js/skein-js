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
import {
  isValidNamespaceDepth,
  MAX_NAMESPACE_DEPTH,
  parseStoreItemFilter,
  SkeinHttpError,
  type Item,
  type SearchItem,
  type StoreNamespaceQuery,
  type StoreRepo,
  type StoreSearchQuery,
} from "@skein-js/core";

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

/**
 * The query a `listNamespaces` batch op describes.
 *
 * `matchConditions` is a list upstream, but `BaseStore.listNamespaces` pushes at most one `prefix` and
 * one `suffix`, so a flat pair loses nothing on the public path; a hand-built `batch()` carrying two
 * conditions of the same type is last-wins, the only shape that cannot round-trip.
 *
 * `limit` and `offset` are carried through rather than dropped. They are *required* fields on
 * `ListNamespacesOperation`, and dropping them left a graph's `store.listNamespaces({ limit: 10 })`
 * reading every namespace in the store.
 */
function namespaceQueryFromListOperation(operation: ListNamespacesOperation): StoreNamespaceQuery {
  const query: StoreNamespaceQuery = { limit: operation.limit, offset: operation.offset };
  for (const condition of operation.matchConditions ?? []) {
    if (condition.matchType === "prefix") query.prefix = condition.path as string[];
    if (condition.matchType === "suffix") query.suffix = condition.path as string[];
  }
  if (operation.maxDepth !== undefined) query.maxDepth = operation.maxDepth;
  return query;
}

/**
 * A LangGraph `BaseStore` backed by a skein `StoreRepo`. All behavior — naive scan in the memory
 * driver, pgvector semantic search in Postgres — comes from the underlying repo; this class only
 * adapts the method shapes.
 *
 * Not adapted: the per-`put` `index` override, because indexing is configured once via
 * `langgraph.json`'s `store.index` rather than per item. It is accepted and ignored rather than
 * throwing. Everything else — `search`'s `filter`, `listNamespaces`' `suffix`/`maxDepth`/wildcards —
 * reaches the repo.
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
    // Validated, not cast. This path has no schema in front of it — a graph node's `filter` reaches
    // the driver directly, where a bad operand is a *crash* rather than a wrong answer (Postgres
    // raises `invalid input syntax for type numeric` on a string bound to `$gt`, surfacing as a 500
    // from inside the run). Same rules the HTTP boundary applies, from the same definition.
    if (options?.filter !== undefined) query.filter = parseStoreItemFilter(options.filter);
    const items = await this.repo.search(query);
    return items.map(toLangGraphSearchItem);
  }

  override async listNamespaces(options?: StoreNamespaceQuery): Promise<string[][]> {
    // `maxDepth` is bounded for the same reason the HTTP schema bounds it: it binds into an array
    // subscript, and Postgres subscripts are `int4`, so an unchecked value overflows and surfaces as
    // a 500 from inside a run. This path has no schema in front of it.
    if (options?.maxDepth !== undefined && !isValidNamespaceDepth(options.maxDepth)) {
      throw SkeinHttpError.badRequest(
        `maxDepth must be an integer between 1 and ${MAX_NAMESPACE_DEPTH} (got ${options.maxDepth}).`,
      );
    }
    // `BaseStore.listNamespaces` defaults to 100 before dispatching to batch; the convenience methods
    // are overridden here, so the default is applied here too — same reasoning as `search`'s 10.
    return this.repo.listNamespaces({ ...options, limit: options?.limit ?? 100 });
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
      // `SearchOperation` is structurally the options bag `search()` reads — query, filter, limit,
      // offset — so it passes straight through.
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
    return this.listNamespaces(namespaceQueryFromListOperation(operation));
  }
}
