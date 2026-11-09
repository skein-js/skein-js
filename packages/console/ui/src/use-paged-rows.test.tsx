import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { usePagedRows } from "./use-paged-rows";

describe("usePagedRows", () => {
  it("walks backward through capped pages from a bookmarked URL without visited history", async () => {
    const rows = Array.from({ length: 10 }, (_, index) => index);
    const onOffsetChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ offset }) =>
        usePagedRows(
          async (start, limit) => rows.slice(start, start + Math.min(limit, 2)),
          "runs",
          4,
          undefined,
          undefined,
          { offset, onOffsetChange },
        ),
      { initialProps: { offset: 8 } },
    );
    await waitFor(() => expect(result.current.rows).toEqual([8, 9]));
    for (const offset of [6, 4, 2, 0]) {
      act(() => result.current.previous());
      expect(onOffsetChange).toHaveBeenLastCalledWith(offset);
      rerender({ offset });
      await waitFor(() => expect(result.current.rows).toEqual([offset, offset + 1]));
    }
  });
  it("restores URL offsets and retains visited boundaries when the server caps pages", async () => {
    const rows = ["a", "b", "c", "d", "e"];
    const onOffsetChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ offset }) =>
        usePagedRows(
          async (start, limit) => rows.slice(start, start + Math.min(limit, 2)),
          "runs",
          50,
          undefined,
          undefined,
          { offset, onOffsetChange },
        ),
      { initialProps: { offset: 0 } },
    );
    await waitFor(() => expect(result.current.rows).toEqual(["a", "b"]));
    act(() => result.current.next());
    expect(onOffsetChange).toHaveBeenLastCalledWith(2);
    rerender({ offset: 2 });
    await waitFor(() => expect(result.current.rows).toEqual(["c", "d"]));
    act(() => result.current.next());
    rerender({ offset: 4 });
    await waitFor(() => expect(result.current.rows).toEqual(["e"]));
    act(() => result.current.previous());
    expect(onOffsetChange).toHaveBeenLastCalledWith(2);
    rerender({ offset: 0 });
    await waitFor(() => expect(result.current.rows).toEqual(["a", "b"]));
  });
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

  it("skips the probe for a page shorter than one the server already returned", async () => {
    const rows = Array.from({ length: 60 }, (_, index) => index);
    const load = vi.fn(async (offset: number, limit: number) => rows.slice(offset, offset + limit));
    const { result } = renderHook(() => usePagedRows(load, "uncapped", 50));
    await waitFor(() => expect(result.current.rows).toEqual(rows.slice(0, 50)));
    expect(load).toHaveBeenCalledTimes(1);

    act(() => result.current.next());
    await waitFor(() => expect(result.current.rows).toEqual(rows.slice(50)));
    expect(result.current.hasNext).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("finds rows added to a collection that filled the server cap exactly", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => index);
    const load = vi.fn(async (offset: number, limit: number) =>
      rows.slice(offset, offset + Math.min(limit, 50)),
    );
    const { result } = renderHook(() => usePagedRows(load, "capped", 50));
    await waitFor(() => expect(result.current.rows).toHaveLength(50));
    expect(result.current.hasNext).toBe(false);

    rows.push(50, 51);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.hasNext).toBe(true));
  });

  it.each([
    { cap: 50, withCount: true },
    { cap: 17, withCount: true },
    { cap: 50, withCount: false },
    { cap: 17, withCount: false },
  ])("visits every row with server cap $cap and count=$withCount", async ({ cap, withCount }) => {
    const rows = Array.from({ length: 123 }, (_, index) => index);
    const load = vi.fn(async (offset: number, limit: number) =>
      rows.slice(offset, offset + Math.min(limit, cap)),
    );
    const { result } = renderHook(() =>
      usePagedRows(load, "capped", 50, withCount ? async () => rows.length : undefined),
    );
    const visited: number[] = [];
    for (let offset = 0; offset < rows.length; offset += cap) {
      await waitFor(() => expect(result.current.rows).toEqual(rows.slice(offset, offset + cap)));
      expect(result.current.offset).toBe(offset);
      visited.push(...result.current.rows!);
      expect(result.current.hasNext).toBe(offset + cap < rows.length);
      if (result.current.hasNext) act(() => result.current.next());
    }
    expect(visited).toEqual(rows);

    const previousOffset = result.current.offset - cap;
    act(() => result.current.previous());
    await waitFor(() =>
      expect(result.current.rows).toEqual(rows.slice(previousOffset, previousOffset + cap)),
    );
    expect(result.current.offset).toBe(previousOffset);
  });
});
