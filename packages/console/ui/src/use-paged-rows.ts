import { useEffect, useRef, useState } from "react";

import { useAsync } from "./use-async";

const firstPageOffsets: readonly number[] = [0];

interface PageResult<Row> {
  queryKey: string;
  page: number;
  offset: number;
  pageSize: number;
  rows: Row[];
  hasNext: boolean;
  total?: number;
}

/** Offset paging for the protocol's bounded list/search operations. */
export function usePagedRows<Row>(
  load: (offset: number, limit: number, signal: AbortSignal) => Promise<Row[]>,
  queryKey: string,
  pageSize: number,
  count?: (signal: AbortSignal) => Promise<number>,
) {
  const [position, setPosition] = useState({ queryKey, pageSize, offsets: firstPageOffsets });
  const offsets =
    position.queryKey === queryKey && position.pageSize === pageSize
      ? position.offsets
      : firstPageOffsets;
  const page = offsets.length - 1;
  const offset = offsets[page]!;
  // The most rows the server has returned in one response. The page cap (`SKEIN_MAX_PAGE_SIZE`) is at
  // least this, so a shorter page cannot have been cut by it. Only this survives reloads: whether a
  // collection *ended* stops being true as soon as a row is added.
  const largestResponse = useRef(0);
  const result = useAsync(
    async (signal) => {
      const [fetched, total] = await Promise.all([
        load(offset, pageSize + 1, signal),
        count?.(signal),
      ]);
      const rows = fetched.slice(0, pageSize);
      // A short response can reflect the server's page cap, even when more rows exist.
      const mayBeCapped = fetched.length >= largestResponse.current;
      largestResponse.current = Math.max(largestResponse.current, fetched.length);
      const hasNext =
        rows.length > 0 &&
        (fetched.length > pageSize ||
          (total === undefined
            ? mayBeCapped && (await load(offset + rows.length, 1, signal)).length > 0
            : offset + rows.length < total));
      return {
        queryKey,
        page,
        offset,
        pageSize,
        rows,
        hasNext,
        ...(total === undefined ? {} : { total }),
      } satisfies PageResult<Row>;
    },
    [queryKey, page, offset, pageSize],
  );
  const current =
    result.data?.queryKey === queryKey &&
    result.data.page === page &&
    result.data.offset === offset &&
    result.data.pageSize === pageSize
      ? result.data
      : undefined;
  const loading = result.loading || (current === undefined && !result.error);

  // A deletion can empty the last page. Return to the preceding page instead of leaving an
  // apparently empty collection with no forward or backward explanation.
  useEffect(() => {
    if (!loading && !result.error && current?.rows.length === 0 && page > 0) {
      setPosition({ queryKey, pageSize, offsets: offsets.slice(0, -1) });
    }
  }, [current, result.error, loading, page, offsets, pageSize, queryKey]);

  return {
    ...result,
    data: current,
    loading,
    rows: current?.rows,
    hasNext: current?.hasNext ?? false,
    total: current?.total,
    offset,
    pageSize,
    page,
    previous: () =>
      setPosition({
        queryKey,
        pageSize,
        offsets: page > 0 ? offsets.slice(0, -1) : firstPageOffsets,
      }),
    next: () => {
      if (!loading && current?.hasNext)
        setPosition({ queryKey, pageSize, offsets: [...offsets, offset + current.rows.length] });
    },
  };
}
