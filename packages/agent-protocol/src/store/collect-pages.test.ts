// The subtle part is the stride: a driver clamps a requested limit down to its own page bound, so the
// page size has to be read off the first page rather than assumed. Assume it and every page looks
// short, so the drain stops after one — which is the bug this helper exists to prevent.

import { describe, expect, it } from "vitest";

import { collectPages } from "./collect-pages.js";

/** A page-bounded source: `rows` served `pageSize` at a time, recording the offsets it was asked for. */
function pagedSource(rows: number[], pageSize: number) {
  const offsets: number[] = [];
  return {
    offsets,
    fetchPage: async (offset: number) => {
      offsets.push(offset);
      return rows.slice(offset, offset + pageSize);
    },
  };
}

describe("collectPages", () => {
  it("reads past the first page, paging by the stride the driver actually returned", async () => {
    // The stride has to come off the first page: a driver clamps a requested limit to its own bound, so
    // assuming the requested size makes every page look short and stops the drain after one.
    const source = pagedSource([1, 2, 3, 4, 5, 6, 7], 3);

    const { rows, truncated } = await collectPages({ fetchPage: source.fetchPage });

    expect(rows).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(truncated).toBe(false);
    expect(source.offsets).toEqual([0, 3, 6]);
  });

  it("stops on a short page without an extra empty query", async () => {
    const source = pagedSource([1, 2, 3, 4], 3);

    await collectPages({ fetchPage: source.fetchPage });

    // The 1-row second page proves exhaustion, so there is no third call.
    expect(source.offsets).toEqual([0, 3]);
  });

  it("needs one extra query when the row count is an exact multiple of the stride", async () => {
    const source = pagedSource([1, 2, 3, 4, 5, 6], 3);

    const { rows } = await collectPages({ fetchPage: source.fetchPage });

    expect(rows).toEqual([1, 2, 3, 4, 5, 6]);
    expect(source.offsets).toEqual([0, 3, 6]);
  });

  // `keep` filters during the drain, but the offsets must still advance by rows *fetched*, not kept —
  // offsetting by the kept count would re-read rows the filter rejected, forever.
  it("keeps only the rows the filter accepts, while paging by rows fetched", async () => {
    const source = pagedSource([1, 2, 3, 4, 5, 6], 2);

    const { rows } = await collectPages({
      fetchPage: source.fetchPage,
      keep: (row) => row % 2 === 0,
    });

    expect(rows).toEqual([2, 4, 6]);
    expect(source.offsets).toEqual([0, 2, 4, 6]);
  });

  it("reports truncated when it gives up at maxRows with rows still unread", async () => {
    const source = pagedSource([1, 2, 3, 4, 5, 6, 7, 8, 9], 3);

    const { rows, truncated } = await collectPages({ fetchPage: source.fetchPage, maxRows: 5 });

    expect(rows).toEqual([1, 2, 3, 4, 5, 6]);
    expect(truncated).toBe(true);
  });

  // Conservative by design: at the cap with a full page in hand, there is no way to know the source
  // is exhausted without another query, so it reports truncated rather than guessing.
  it("reports truncated at maxRows even when the source happened to run out there", async () => {
    const source = pagedSource([1, 2, 3, 4, 5, 6], 3);

    expect((await collectPages({ fetchPage: source.fetchPage, maxRows: 6 })).truncated).toBe(true);
  });

  it("handles an empty source", async () => {
    const source = pagedSource([], 3);

    const { rows, truncated } = await collectPages({ fetchPage: source.fetchPage });

    expect(rows).toEqual([]);
    expect(truncated).toBe(false);
  });
});
