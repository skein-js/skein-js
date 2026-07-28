// Reading more rows than one driver page holds, for the two places that need *all* matching rows
// rather than a page of them: the ownership filter in `auth/auth-scoped-store.ts` (which filters after
// the read, so a page of rows is not a page of the caller's rows) and the `delete_threads` cascade in
// `assistants/assistant-service.ts` (which is choosing what to delete, not rendering a page).
//
// Both used to pass no `limit` and rely on the driver returning everything. Since every list/search
// path is page-bounded (see docs/storage.md), that no longer holds — and the failure mode is silent:
// a truncated set reads as "these are all the matching rows".

/** How many rows one drain may read before giving up. See {@link collectPages}. */
export const DEFAULT_MAX_COLLECTED_ROWS = 100_000;

export interface CollectPagesResult<T> {
  /** The kept rows, in the order the pages returned them. */
  rows: T[];
  /** Rows one page holds — what the driver actually returned for the first page, not what was asked. */
  stride: number;
  /**
   * True when the scan gave up at `maxRows`. There *may* be unread rows — proving otherwise would cost
   * another query, so this is deliberately conservative: it means "the cap stopped me", not "rows were
   * definitely dropped". A caller that must not truncate silently should surface it.
   */
  truncated: boolean;
}

/**
 * Drain a page-bounded search one page at a time, keeping the rows `keep` accepts.
 *
 * The **first page establishes the stride**: a driver clamps a requested `limit` down to its own page
 * bound, so the page size cannot be assumed from what was asked for — and assuming it means treating
 * every page as short, i.e. stopping after one. A later page shorter than the stride is what proves
 * the source is exhausted.
 *
 * `stop` is consulted after each page so a caller that only needs the first N kept rows doesn't read
 * the whole table. `maxRows` is a backstop for the opposite case: a `keep` that matches almost nothing
 * would otherwise turn one request into thousands of queries.
 */
export async function collectPages<T>(options: {
  /** Fetch one page starting at `offset`. Pass no limit so the driver applies its own page bound. */
  fetchPage: (offset: number) => Promise<T[]>;
  /** Keep a row. Omitted → keep every row. */
  keep?: (row: T) => boolean;
  /** Stop early once the kept rows are enough. Called with the page stride, after each page. */
  stop?: (kept: readonly T[], stride: number) => boolean;
  /** Rows to read before giving up. Defaults to {@link DEFAULT_MAX_COLLECTED_ROWS}. */
  maxRows?: number;
}): Promise<CollectPagesResult<T>> {
  const { fetchPage, keep, stop, maxRows = DEFAULT_MAX_COLLECTED_ROWS } = options;
  const rows: T[] = [];
  let scanned = 0;
  let stride = 0;

  for (;;) {
    const page = await fetchPage(scanned);
    if (page.length === 0) return { rows, stride, truncated: false };
    if (stride === 0) stride = page.length;
    scanned += page.length;
    for (const row of page) {
      if (!keep || keep(row)) rows.push(row);
    }
    // A short page means there is nothing after it. Checked before `stop` so an exhausted source is
    // never reported as truncated.
    if (page.length < stride) return { rows, stride, truncated: false };
    if (stop?.(rows, stride)) return { rows, stride, truncated: false };
    if (scanned >= maxRows) return { rows, stride, truncated: true };
  }
}
