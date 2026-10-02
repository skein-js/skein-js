import { useEffect, useState } from "react";

import { useAsync } from "./use-async";

interface PageResult<Row> {
  queryKey: string;
  page: number;
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
  const [position, setPosition] = useState({ queryKey, page: 0 });
  const page = position.queryKey === queryKey ? position.page : 0;
  const offset = page * pageSize;
  const result = useAsync(
    async (signal) => {
      const [fetched, total] = await Promise.all([
        load(offset, pageSize + 1, signal),
        count?.(signal),
      ]);
      return {
        queryKey,
        page,
        rows: fetched.slice(0, pageSize),
        hasNext: fetched.length > pageSize,
        ...(total === undefined ? {} : { total }),
      } satisfies PageResult<Row>;
    },
    [queryKey, page, pageSize],
  );
  const current =
    result.data?.queryKey === queryKey && result.data.page === page ? result.data : undefined;
  const loading = result.loading || (current === undefined && !result.error);

  // A deletion can empty the last page. Return to the preceding page instead of leaving an
  // apparently empty collection with no forward or backward explanation.
  useEffect(() => {
    if (!loading && !result.error && current?.rows.length === 0 && page > 0) {
      setPosition({ queryKey, page: page - 1 });
    }
  }, [current, result.error, loading, page, queryKey]);

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
    previous: () => setPosition({ queryKey, page: Math.max(0, page - 1) }),
    next: () => setPosition({ queryKey, page: page + 1 }),
  };
}
