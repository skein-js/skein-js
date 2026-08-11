// Paging, shared by every collection repository — and the bound a driver applies when a caller asks
// for no limit at all.

/** Offset pagination shared by collection repositories. HTTP callers must always set a limit. */
export interface Pagination {
  limit?: number;
  offset?: number;
}

/**
 * Rows a `search` returns when the caller does not ask for a limit.
 *
 * "No limit" used to mean *every* row, which for threads meant every thread's full mirrored graph
 * state — a single `POST /threads/search` with an empty body could pull an entire table into the
 * heap. An absent limit now means the first page, which is what a caller almost always wanted.
 *
 * Matches the cap the request schemas already enforce on an explicit `limit`, so the implicit and
 * explicit ceilings agree. Drivers take it as an option so a deployment can lower it; both drivers
 * apply it, and the shared conformance suite holds them to that.
 */
export const DEFAULT_MAX_PAGE_SIZE = 1000;

/**
 * Validate a driver's `maxPageSize`, returning it. Every driver runs its option through this, so the
 * invariant holds wherever the value enters — the environment path validates too, but an embedder can
 * pass a literal.
 *
 * Both failure directions are silent without a guard, which is why this exists rather than a comment:
 * a non-positive or `NaN` bound makes the memory driver's `slice` return nothing, so **every list and
 * search comes back empty** with no error; and a value past `Number.MAX_SAFE_INTEGER` reaches `pg` as
 * exponential notation (`1e+21`), so every query fails with an `invalid input syntax for type bigint`
 * — after a clean boot.
 */
export function requireValidMaxPageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      `maxPageSize must be a positive integer no larger than ${Number.MAX_SAFE_INTEGER} (got ${value}).`,
    );
  }
  return value;
}
