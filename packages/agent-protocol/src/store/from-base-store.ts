// Adapts a LangGraph `BaseStore` into skein's `StoreRepo`, so `store.adapter` can point at
// `PostgresStore`, `InMemoryStore`, or anything else implementing that interface and have it serve the
// whole `/store/*` surface. The exact inverse of `SkeinBaseStore` — read the two together.
//
// **This adapter re-imposes skein's semantics in JS rather than forwarding them.** That is the load-
// bearing decision, and it is not merely about tidiness: forwarding would be *unsafe*, and it would
// fail the shared conformance suite. Verified against `@langchain/langgraph-checkpoint@1.1.3`'s
// `InMemoryStore`:
//
//   - `search`'s prefix is a raw **string** prefix (`namespace.startsWith(prefix.join(":"))`), where
//     skein's is segment-wise. So a prefix of `["users"]` there also matches `["users2", …]`, and a
//     prefix of `["@u","alice"]` also matches `["@u","alice2", …]`. For a deployment whose
//     `@auth.on.store` handler roots the namespace at the principal, that difference is a cross-tenant
//     read — the scoping is sound and the store it sits on top of leaks past it.
//     (Confusingly, the same class's `listNamespaces` *is* segment-wise and wildcard-aware. The two
//     disagree with each other upstream.)
//   - `search` **silently ignores `query`** when no index is configured, where skein's drivers fall
//     back to a naive substring match over the serialized value.
//   - filter operands are coerced with `Number()`, the one rule Phase 1 deliberately rejected because
//     Postgres cannot reproduce it (`'abc'::numeric` throws where `Number("abc")` yields `NaN`).
//   - namespace ordering is `join(":").localeCompare`, not element-wise.
//
// So the adapted store is asked for a *candidate set* — narrowed by whatever prefix it can honour, and
// ranked by its vector index when it has one, which is the capability worth borrowing — and skein
// applies matching, filtering, ordering and paging on top, from the same definitions both bundled
// drivers use. The cost is over-fetching: more source rows are read than are returned, and paging is
// applied after re-filtering. That is the trade Postgres already makes and documents on its no-index
// text path, so it is a known shape rather than a new one.

import type { BaseStore, Item as LangGraphItem } from "@langchain/langgraph";
import {
  compareNamespaces,
  DEFAULT_MAX_PAGE_SIZE,
  matchesItemFilter,
  matchesNamespacePrefix,
  matchesNamespaceQuery,
  NAMESPACE_WILDCARD,
  requireValidMaxPageSize,
  SkeinHttpError,
  truncateNamespaceDepth,
  type Item,
  type SearchItem,
  type StoreNamespaceQuery,
  type StorePutOptions,
  type StoreRepo,
  type StoreSearchQuery,
} from "@skein-js/core";

/** How many source rows a scan may read per row it could return. */
const SCAN_ROWS_PER_RESULT = 10;

/**
 * How many source rows one call may read while draining a store bounded at `maxPageSize`.
 *
 * A bound is needed because re-imposing the filter means paging the source until enough *matches*
 * accumulate, and a narrow filter over a large store would otherwise walk the whole thing. Ten source
 * rows per returnable row: generous enough that realistic queries complete, small enough that a
 * pathological one gives up rather than pinning the process. Exceeding it returns what was found so far —
 * a short page, which the store contract already tells callers to page past rather than trust as the end.
 *
 * Scaled off the *effective* bound rather than fixed at the default, because `SKEIN_MAX_PAGE_SIZE` can
 * raise it: a fixed `10 × 1000` meant a deployment bounded at 20 000 could never fill a single page no
 * matter how many matches existed.
 */
export function defaultAdapterScanLimit(maxPageSize: number = DEFAULT_MAX_PAGE_SIZE): number {
  return maxPageSize * SCAN_ROWS_PER_RESULT;
}

/** How many rows to pull per source request while draining. */
const SOURCE_PAGE_SIZE = 200;

export interface FromBaseStoreOptions {
  /**
   * Page bound applied to every read, since `BaseStore` has no equivalent of its own. Defaults to
   * {@link DEFAULT_MAX_PAGE_SIZE}, so an adapted store cannot serve an unbounded page.
   */
  maxPageSize?: number;
  /** Source rows one call may scan. Defaults to {@link defaultAdapterScanLimit} of `maxPageSize`. */
  scanLimit?: number;
  /**
   * `store.ttl.default_ttl` in minutes, stamped onto every `put` that names no `ttl` of its own.
   *
   * Passed in rather than read off the adapted store because `store.ttl` is *skein's* config, and
   * nothing would otherwise apply it: `BaseStore.put` has no `ttl` parameter, so a configured retention
   * policy would be accepted at startup and then never reach a single write. Only meaningful against a
   * store that can expire items — `resolveStoreAdapter` refuses the config otherwise.
   *
   * `refresh_on_read` has no counterpart here: `BaseStore.get` cannot express it, so it is refused at
   * startup rather than silently not happening.
   */
  defaultTtl?: number;
}

/** A `BaseStore` that also exposes TTL sweeping — how `PostgresStore` declares the capability. */
interface SweepingStore {
  sweepExpiredItems(): Promise<number>;
}

/** True when the adapted store can expire items, so `ttl` is honourable rather than silently dropped. */
export function supportsStoreTtl(store: BaseStore): boolean {
  return typeof (store as Partial<SweepingStore>).sweepExpiredItems === "function";
}

/** `BaseStore.put` widened to `PostgresStore`'s 5-arg form, which carries the per-item `ttl`. */
type TtlAwarePut = (
  namespace: string[],
  key: string,
  value: Record<string, unknown>,
  index?: false | string[],
  options?: { ttl?: number },
) => Promise<void>;

/**
 * LangGraph `Item` → wire `Item`: `Date` timestamps become ISO strings, and `value` is **cloned**.
 *
 * Timestamps are coerced through `new Date(...)` rather than calling `.toISOString()` directly, because
 * the type says `Date` but a third-party store is free to hand back an ISO string it read out of a
 * column — and a `TypeError` from inside a search is a worse failure than accepting both.
 *
 * `value` is cloned because the conformance suite requires that mutating a returned item cannot reach
 * the stored row: Postgres serializes, so its rows are isolated for free, and the memory driver
 * `structuredClone`s to match. `InMemoryStore` hands out the stored object *by reference*, so without
 * this a caller — or a graph node — mutating what it read would silently rewrite the store. Cloning here
 * rather than trusting the source is the same principle as re-imposing the filter.
 */
function toWireItem(item: LangGraphItem): Item {
  return {
    namespace: [...item.namespace],
    key: item.key,
    value: structuredClone(item.value),
    createdAt: new Date(item.createdAt).toISOString(),
    updatedAt: new Date(item.updatedAt).toISOString(),
  };
}

/** The wire `SearchItem`, carrying the source's relevance score through when it produced one. */
function toWireSearchItem(item: LangGraphItem & { score?: number }): SearchItem {
  const base = toWireItem(item);
  return item.score === undefined ? base : { ...base, score: item.score };
}

/**
 * The longest leading run of literal segments in `prefix`.
 *
 * A wildcard cannot be expressed to an arbitrary `BaseStore` — `InMemoryStore`'s `search` would compare
 * it as the literal string `"*"` and match nothing at all — so only the concrete head is pushed down
 * and the full positional match is re-applied in JS. Narrowing at the source is an optimization; the
 * correctness comes from the JS pass.
 */
function pushablePrefix(prefix: readonly string[] | undefined): string[] {
  if (!prefix) return [];
  const wildcardAt = prefix.indexOf(NAMESPACE_WILDCARD);
  return [...(wildcardAt === -1 ? prefix : prefix.slice(0, wildcardAt))];
}

/** The naive substring match skein's drivers apply to `query` when no vector index is configured. */
function matchesTextQuery(item: Item, needle: string): boolean {
  return JSON.stringify(item.value).toLowerCase().includes(needle.toLowerCase());
}

/**
 * A `StoreRepo` backed by a LangGraph `BaseStore`.
 *
 * Two divergences the interfaces cannot bridge, both resolved rather than shrugged at:
 *
 * - **`StoreRepo.put` returns the `Item`; `BaseStore.put` returns `void`.** So `put` writes and then
 *   reads back, which costs a round trip and is **racy**: a concurrent write to the same key between
 *   the two returns the *other* writer's item, and a concurrent delete returns nothing (in which case
 *   the value just written is reported with fresh timestamps, since the write did happen and failing a
 *   successful write would be worse). Widening `StoreRepo.put` to `void` was the alternative and would
 *   have degraded both bundled drivers to serve the adapter, which is backwards.
 * - **TTL is invisible through `BaseStore`.** `sweepExpired` works only when the store declares
 *   `sweepExpiredItems` (how `PostgresStore` exposes it), and a per-item `ttl` is passed through
 *   `PostgresStore`'s 5-argument `put` only when it does. A store without it **refuses** a `ttl`
 *   rather than accepting and discarding one — a silently ignored retention policy is worse than an
 *   error, and `store.ttl` in config is refused at startup for the same reason.
 */
export function fromBaseStore(store: BaseStore, options?: FromBaseStoreOptions): StoreRepo {
  const maxPageSize = requireValidMaxPageSize(options?.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE);
  const scanLimit = options?.scanLimit ?? defaultAdapterScanLimit(maxPageSize);
  const ttlSupported = supportsStoreTtl(store);

  // Checked here, not only at config load: a `defaultTtl` this store cannot honour would otherwise be
  // discarded on every write by the same code that refuses an explicit per-item `ttl`, which is the
  // inconsistency the refusal exists to prevent. Thrown at construction so it surfaces at boot.
  if (options?.defaultTtl !== undefined && !ttlSupported) {
    throw new Error(
      "A `defaultTtl` was configured, but this store cannot expire items — it exposes no " +
        "`sweepExpiredItems()`, so the retention policy would silently never apply. Use a store that " +
        "does (e.g. `PostgresStore`), or drop the TTL config.",
    );
  }

  const pageLimit = (limit?: number): number => Math.min(limit ?? maxPageSize, maxPageSize);

  /** Every distinct namespace the source knows, drained in pages. */
  const drainNamespaces = async (): Promise<string[][]> => {
    const namespaces: string[][] = [];
    for (let offset = 0; namespaces.length < scanLimit; offset += SOURCE_PAGE_SIZE) {
      const page = await store.listNamespaces({ limit: SOURCE_PAGE_SIZE, offset });
      namespaces.push(...page);
      if (page.length < SOURCE_PAGE_SIZE) break;
    }
    return namespaces;
  };

  /**
   * The prefixes to ask the source for, covering everything skein's `prefix` can mean.
   *
   * A skein search with no prefix — or one whose first segment is a wildcard — means *every* namespace,
   * which not every `BaseStore` will accept as an empty prefix: `PostgresStore.validateNamespace`
   * rejects `[]` outright ("Namespace cannot be empty"), because its search matches with
   * `namespace_path LIKE ${prefix}%` and an empty prefix is a different question than it wants to
   * answer. So when nothing concrete can be pushed down, the namespaces are enumerated and each is
   * searched in turn. One extra round trip per namespace, on the query shape that was always going to
   * be a full scan.
   */
  const sourcePrefixes = async (prefix: readonly string[] | undefined): Promise<string[][]> => {
    const pushable = pushablePrefix(prefix);
    return pushable.length > 0 ? [pushable] : await drainNamespaces();
  };

  /**
   * Pull source rows under each of `prefixes` until `enough(matches)` or the sources are exhausted.
   *
   * `query` is forwarded so a store with a vector index does its own ranking — the capability worth
   * borrowing from an adapted store, and the reason the caller re-sorts by score when one came back.
   *
   * **Results are de-duplicated by namespace + key.** A prefix-less search asks about every namespace,
   * and a `BaseStore` whose prefix match is a raw string returns a nested namespace's items under its
   * ancestor's prefix too — so `["memories"]` and `["memories","alice"]` both yield the deep item, and
   * so do the *sibling* namespaces `["users","1"]` and `["users","10"]`. Without this, a prefix-less
   * search returns the same item several times.
   *
   * **`enough` is only consulted when nothing narrows results after the drain.** The caller may still
   * apply a text predicate (when the source ignored `query`) or a global re-sort (when it did not), and
   * stopping at `offset + limit` *candidates* would then page a set that had not been narrowed yet — a
   * late match past the first window would simply be missed. So a `query` search reads to exhaustion or
   * `scanLimit`, which is the same trade skein's Postgres driver documents on its own no-index text path.
   */
  const drainSearch = async (
    prefixes: readonly string[][],
    query: string | undefined,
    keep: (item: SearchItem) => boolean,
    enough: ((kept: number) => boolean) | undefined,
  ): Promise<{ kept: SearchItem[]; sourceScored: boolean }> => {
    const kept: SearchItem[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    let sourceScored = false;
    const done = (): boolean => scanned >= scanLimit || (enough?.(kept.length) ?? false);
    for (const prefix of prefixes) {
      if (done()) break;
      for (let offset = 0; !done(); offset += SOURCE_PAGE_SIZE) {
        const page = await store.search(prefix, {
          limit: SOURCE_PAGE_SIZE,
          offset,
          ...(query !== undefined ? { query } : {}),
        });
        scanned += page.length;
        for (const raw of page) {
          const item = toWireSearchItem(raw);
          if (item.score !== undefined) sourceScored = true;
          const identity = JSON.stringify([item.namespace, item.key]);
          if (seen.has(identity)) continue;
          seen.add(identity);
          if (keep(item)) kept.push(item);
        }
        if (page.length < SOURCE_PAGE_SIZE) break;
      }
    }
    return { kept, sourceScored };
  };

  return {
    get: async (namespace, key) => {
      const item = await store.get(namespace, key);
      return item ? toWireItem(item) : null;
    },

    put: async (namespace, key, value, putOptions?: StorePutOptions) => {
      if (putOptions?.ttl !== undefined && !ttlSupported) {
        // A 400, not a bare `Error`: the caller asked for something this deployment cannot do, and a 500
        // would read as "skein broke" rather than "drop the `ttl` or use a store that can expire items".
        throw SkeinHttpError.badRequest(
          "The configured store adapter cannot expire items, so a per-item `ttl` would be silently " +
            "discarded. Use a store exposing `sweepExpiredItems()` (e.g. `PostgresStore`), or omit `ttl`.",
        );
      }
      // An explicit per-item `ttl` wins over the configured default, matching both bundled drivers.
      const ttl = putOptions?.ttl ?? options?.defaultTtl;
      if (ttl !== undefined) {
        await (store.put as TtlAwarePut)(namespace, key, value, undefined, { ttl });
      } else {
        await store.put(namespace, key, value);
      }
      const written = await store.get(namespace, key);
      // Racy by construction — see the class doc. A concurrent delete leaves nothing to read back, and
      // reporting the value just written beats failing a write that succeeded.
      if (written) return toWireItem(written);
      // Cloned like the success path: the isolation contract ("mutating a returned item cannot reach the
      // store") must not depend on which branch answered, and returning the caller's own objects by
      // reference would hand them a value the next write can change under them.
      const at = new Date().toISOString();
      return {
        namespace: [...namespace],
        key,
        value: structuredClone(value),
        createdAt: at,
        updatedAt: at,
      };
    },

    delete: async (namespace, key) => {
      await store.delete(namespace, key);
    },

    search: async (query: StoreSearchQuery) => {
      const limit = pageLimit(query.limit);
      const offset = query.offset ?? 0;
      const prefix = query.prefix;

      // Filter and prefix are re-applied here, never forwarded: the source's operator coercion and its
      // prefix semantics both differ from skein's. The `query` text match is the one rule that depends
      // on what the source did — see below.
      const matches = (item: SearchItem): boolean => {
        if (prefix?.length && !matchesNamespacePrefix(item.namespace, prefix)) return false;
        return matchesItemFilter(item.value, query.filter);
      };

      const { kept, sourceScored } = await drainSearch(
        await sourcePrefixes(prefix),
        query.query,
        matches,
        // Only a plain prefix/filter search can stop early: nothing narrows or reorders its results
        // after the drain, so the first `offset + limit` matches really are the page. A `query` search
        // still has a text predicate or a global re-sort to come — see `drainSearch`.
        query.query === undefined ? (count) => count >= offset + limit : undefined,
      );

      // A source that returned no score for any row did not act on `query` — `InMemoryStore` ignores it
      // outright without a vector index. Fall back to the naive substring match skein's own drivers
      // apply, so `search({ query })` narrows on every substrate rather than only on indexed ones.
      // A source that *did* score has already ranked and narrowed; second-guessing it would discard the
      // semantic result this adapter exists to reach.
      if (query.query !== undefined && !sourceScored) {
        const needle = query.query;
        return (
          kept
            .filter((item) => matchesTextQuery(item, needle))
            // `score: 1` on a naive hit, matching both bundled drivers: a text match is not ranked, so
            // every hit is equally good, and omitting the field would make an adapted store the only one
            // whose text search answers without a score.
            .map((item) => ({ ...item, score: 1 }))
            .slice(offset, offset + limit)
        );
      }

      // Ranked results are re-sorted globally before paging. A prefix-less search is served by asking
      // each namespace separately, so the source's per-call ranking is per-namespace; scores are cosine
      // similarities in one embedding space, so they compare across namespaces and one sort restores the
      // global order. Descending, and a stable sort leaves a single-prefix search in the order it came.
      if (sourceScored) kept.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return kept.slice(offset, offset + limit);
    },

    listNamespaces: async (query?: StoreNamespaceQuery) => {
      const limit = pageLimit(query?.limit);
      const offset = query?.offset ?? 0;

      // Matched, truncated, ordered and paged here rather than pushed down. Upstream's `listNamespaces`
      // happens to match positionally like ours, but it orders by `join(":")` and a third-party store
      // need not do either — and truncation must precede paging, which a source cannot know.
      const matched = (await drainNamespaces()).filter((namespace) =>
        matchesNamespaceQuery(namespace, query),
      );
      const truncated =
        query?.maxDepth === undefined ? matched : truncateNamespaceDepth(matched, query.maxDepth);
      return truncated.sort(compareNamespaces).slice(offset, offset + limit);
    },

    sweepExpired: async () => {
      // Capability-detected. A store that cannot expire items has nothing to sweep, and `store.ttl` is
      // refused at startup against such a store, so zero is the honest answer rather than a silent lie.
      if (!ttlSupported) return 0;
      return (store as unknown as SweepingStore).sweepExpiredItems();
    },
  };
}
