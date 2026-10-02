import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { usePagedRows } from "./use-paged-rows";

describe("usePagedRows", () => {
  it("moves through page boundaries and resets when the query changes", async () => {
    const rows = ["a", "b", "c", "d", "e"];
    const load = vi.fn(async (offset: number, limit: number) => rows.slice(offset, offset + limit));
    const { result, rerender } = renderHook(({ queryKey }) => usePagedRows(load, queryKey, 2), {
      initialProps: { queryKey: "all" },
    });

    await waitFor(() => expect(result.current.rows).toEqual(["a", "b"]));
    expect(result.current.hasNext).toBe(true);
    act(() => result.current.next());
    await waitFor(() => expect(result.current.rows).toEqual(["c", "d"]));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.rows).toEqual(["e"]));
    expect(result.current.hasNext).toBe(false);

    rerender({ queryKey: "filtered" });
    await waitFor(() => expect(result.current.rows).toEqual(["a", "b"]));
    expect(result.current.offset).toBe(0);
    expect(load).toHaveBeenCalledWith(0, 3, expect.any(AbortSignal));
  });

  it("returns to the previous page when deletion empties the current page", async () => {
    const rows = ["a", "b", "c"];
    const load = async (offset: number, limit: number) => rows.slice(offset, offset + limit);
    const { result } = renderHook(() => usePagedRows(load, "all", 2));
    await waitFor(() => expect(result.current.rows).toEqual(["a", "b"]));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.rows).toEqual(["c"]));

    rows.pop();
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.offset).toBe(0));
    await waitFor(() => expect(result.current.rows).toEqual(["a", "b"]));
  });
});
