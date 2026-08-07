// Positional namespace matching for the long-term store — the shared semantics behind
// `listNamespaces`' `prefix`, `suffix` and `maxDepth`.
//
// Ported from LangGraph's `doesMatch` / `listNamespacesOperation`
// (`@langchain/langgraph-checkpoint/dist/store/memory.js`), which is the conformance oracle: a graph
// written against `getStore()` must see the same matching here as on LangGraph Platform. It is
// reimplemented rather than imported because those functions are internal to `InMemoryStore` and are
// not part of the package's public exports.
//
// The memory driver runs these directly. The Postgres driver expresses the same rules in SQL so the
// page bound applies to the *matched* set rather than to a full-table read sliced afterwards; the
// shared conformance suite is what proves the two agree.

/**
 * The wildcard segment: matches exactly one namespace segment, whatever it is.
 *
 * One segment, not a glob — `["users", "*"]` matches `["users", "1"]`, never `["users"]`. It is a
 * positional "anything here", which is why a stored namespace containing a literal `"*"` segment is
 * indistinguishable from a wildcard. Upstream cannot tell them apart either, and matching it is the
 * compatible behaviour.
 */
export const NAMESPACE_WILDCARD = "*";

/**
 * Ceiling on {@link StoreNamespaceQuery.maxDepth}.
 *
 * A bound is needed even though truncation can only ever shorten the result: the value binds into an
 * array subscript, and Postgres subscripts are `int4` — an unbounded one overflows and surfaces as a
 * 500 where it should be a 400. Shared so the HTTP schema and the `getStore()` guard agree; no real
 * namespace is anywhere near this deep.
 */
export const MAX_NAMESPACE_DEPTH = 1000;

/** True if `depth` is a usable `maxDepth` — a positive integer within {@link MAX_NAMESPACE_DEPTH}. */
export function isValidNamespaceDepth(depth: number): boolean {
  return Number.isSafeInteger(depth) && depth >= 1 && depth <= MAX_NAMESPACE_DEPTH;
}

/** What `listNamespaces` restricts and pages by. */
export interface StoreNamespaceQuery {
  /**
   * Match from the first segment. `"*"` matches any one segment at that position.
   *
   * A path shorter than the namespace still matches — `["users"]` and `["users", "*"]` both match
   * `["users", "1", "memories"]` — so this narrows a subtree rather than selecting one depth.
   */
  prefix?: string[];
  /** Match from the last segment, same wildcard rule. ANDed with {@link prefix}. */
  suffix?: string[];
  /**
   * Truncate each matched namespace to its first `maxDepth` segments, then de-duplicate.
   *
   * Applied after matching and before paging, so `{ maxDepth: 1, limit: 10 }` pages ten *roots*, not
   * the roots of the first ten namespaces.
   */
  maxDepth?: number;
  limit?: number;
  offset?: number;
}

/** True if `path` contains a wildcard — the Postgres driver's cue that its slice form won't do. */
export function hasNamespaceWildcard(path: readonly string[]): boolean {
  return path.some((segment) => segment === NAMESPACE_WILDCARD);
}

/** True if `path` matches `namespace` from the front, `"*"` matching any one segment. */
export function matchesNamespacePrefix(
  namespace: readonly string[],
  path: readonly string[],
): boolean {
  if (path.length > namespace.length) return false;
  return path.every(
    (segment, index) => segment === NAMESPACE_WILDCARD || namespace[index] === segment,
  );
}

/** True if `path` matches `namespace` from the back, `"*"` matching any one segment. */
export function matchesNamespaceSuffix(
  namespace: readonly string[],
  path: readonly string[],
): boolean {
  if (path.length > namespace.length) return false;
  const start = namespace.length - path.length;
  return path.every(
    (segment, index) => segment === NAMESPACE_WILDCARD || namespace[start + index] === segment,
  );
}

/**
 * True if `namespace` satisfies every condition on `query`. Conditions are ANDed, and an absent or
 * empty path is not a condition — `{}` matches everything, which is what "no filter" has to mean.
 */
export function matchesNamespaceQuery(
  namespace: readonly string[],
  query?: StoreNamespaceQuery,
): boolean {
  if (query?.prefix?.length && !matchesNamespacePrefix(namespace, query.prefix)) return false;
  if (query?.suffix?.length && !matchesNamespaceSuffix(namespace, query.suffix)) return false;
  return true;
}

/**
 * Truncate each namespace to `maxDepth` segments and drop duplicates, keeping first-seen order.
 *
 * Keyed by `JSON.stringify` rather than `join`, for the same reason `listNamespaces` itself is:
 * distinct namespaces whose segments contain the separator must not collide.
 */
export function truncateNamespaceDepth(
  namespaces: readonly (readonly string[])[],
  maxDepth: number,
): string[][] {
  const seen = new Map<string, string[]>();
  for (const namespace of namespaces) {
    const truncated = namespace.slice(0, maxDepth);
    seen.set(JSON.stringify(truncated), truncated);
  }
  return [...seen.values()];
}

/**
 * Ascending element-wise order: segment by segment, shorter first on a shared prefix.
 *
 * Compares with `<`, i.e. UTF-16 code-unit order. Postgres orders `text[]` under the database's
 * collation instead, so the two drivers can disagree on segments where a locale collation differs
 * from code-unit order (`"a-b"` vs `"ab"` under `en_US.UTF-8`). Forcing agreement isn't available —
 * `COLLATE "C"` can't apply to `text[]`, and flattening to a string reintroduces the separator
 * collision. The contract is therefore "ascending, element-wise; segment order follows the driver's
 * collation", and the conformance suite pins it with ASCII-lowercase segments only.
 */
export function compareNamespaces(a: readonly string[], b: readonly string[]): number {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const left = a[index] as string;
    const right = b[index] as string;
    if (left !== right) return left < right ? -1 : 1;
  }
  return a.length - b.length;
}
