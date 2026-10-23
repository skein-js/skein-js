import { describe, expect, it } from "vitest";

import { EXTRACT_PATH, projectSearchRow } from "./project-search-row.js";

describe("search projection", () => {
  it("selects fields and extracts negative array indexes without modifying the row", () => {
    const row = {
      thread_id: "one",
      metadata: { label: "private" },
      values: { messages: [{ text: "first" }, { text: "last" }] },
    };
    expect(
      projectSearchRow(row, ["thread_id"], {
        last: "values.messages[-1].text",
        absent: "metadata.absent",
      }),
    ).toEqual({ thread_id: "one", last: "last", absent: null });
    expect(row.metadata).toEqual({ label: "private" });
  });
  it("accepts only supported data paths and never traverses prototypes", () => {
    expect(EXTRACT_PATH.test("values.messages[-1].text")).toBe(true);
    expect(EXTRACT_PATH.test("values.messages.map(() => process.env)")).toBe(false);
    expect(projectSearchRow({ values: {} }, [], { inherited: "values.constructor" })).toEqual({
      inherited: null,
    });
  });
});
