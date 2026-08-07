import { describe, expect, it } from "vitest";

import {
  isStoreFilterOperators,
  matchesItemFilter,
  parseStoreItemFilter,
  storeItemFilterProblem,
} from "./item-filter.js";

describe("isStoreFilterOperators", () => {
  it("recognizes a bag whose every key is an operator", () => {
    expect(isStoreFilterOperators({ $gt: 3 })).toBe(true);
    expect(isStoreFilterOperators({ $gte: 3, $lt: 9 })).toBe(true);
    // Stating no conditions is still an operator bag, not a scalar.
    expect(isStoreFilterOperators({})).toBe(true);
  });

  it("rejects scalars and mixed objects", () => {
    expect(isStoreFilterOperators("red")).toBe(false);
    expect(isStoreFilterOperators(null)).toBe(false);
    expect(isStoreFilterOperators(3)).toBe(false);
    // Mixed bags fall through to scalar comparison, where they never match — the HTTP boundary
    // refuses this shape rather than letting it silently narrow to nothing.
    expect(isStoreFilterOperators({ $eq: 1, colour: "red" } as never)).toBe(false);
  });
});

describe("matchesItemFilter", () => {
  it("matches everything on an absent or empty filter", () => {
    expect(matchesItemFilter({ score: 5 })).toBe(true);
    expect(matchesItemFilter({ score: 5 }, {})).toBe(true);
  });

  it("compares a bare scalar for equality", () => {
    expect(matchesItemFilter({ topic: "coffee" }, { topic: "coffee" })).toBe(true);
    expect(matchesItemFilter({ topic: "coffee" }, { topic: "tea" })).toBe(false);
    expect(matchesItemFilter({ done: false }, { done: false })).toBe(true);
  });

  it("ANDs across keys and across operators on one key", () => {
    const value = { score: 5, topic: "coffee" };

    expect(matchesItemFilter(value, { score: 5, topic: "coffee" })).toBe(true);
    expect(matchesItemFilter(value, { score: 5, topic: "tea" })).toBe(false);
    expect(matchesItemFilter(value, { score: { $gte: 3, $lt: 9 } })).toBe(true);
    expect(matchesItemFilter(value, { score: { $gte: 3, $lt: 5 } })).toBe(false);
  });

  it("supports $eq and $ne", () => {
    expect(matchesItemFilter({ topic: "coffee" }, { topic: { $eq: "coffee" } })).toBe(true);
    expect(matchesItemFilter({ topic: "coffee" }, { topic: { $ne: "tea" } })).toBe(true);
    expect(matchesItemFilter({ topic: "coffee" }, { topic: { $ne: "coffee" } })).toBe(false);
  });

  it("supports $in and $nin", () => {
    expect(matchesItemFilter({ topic: "coffee" }, { topic: { $in: ["coffee", "tea"] } })).toBe(
      true,
    );
    expect(matchesItemFilter({ topic: "cocoa" }, { topic: { $in: ["coffee", "tea"] } })).toBe(
      false,
    );
    expect(matchesItemFilter({ topic: "cocoa" }, { topic: { $nin: ["coffee", "tea"] } })).toBe(
      true,
    );
  });

  it("orders numbers", () => {
    expect(matchesItemFilter({ score: 5 }, { score: { $gt: 3 } })).toBe(true);
    expect(matchesItemFilter({ score: 5 }, { score: { $gt: 5 } })).toBe(false);
    expect(matchesItemFilter({ score: 5 }, { score: { $gte: 5 } })).toBe(true);
    expect(matchesItemFilter({ score: 5 }, { score: { $lt: 9 } })).toBe(true);
    expect(matchesItemFilter({ score: 5 }, { score: { $lte: 5 } })).toBe(true);
  });

  it("orders numbers only — a non-number never matches an ordering operator", () => {
    // The one deliberate departure from LangGraph, which coerces both sides with `Number()`. Pinned
    // here because Postgres cannot reproduce that coercion without `'abc'::numeric` throwing.
    expect(matchesItemFilter({ score: "5" }, { score: { $gt: 3 } })).toBe(false);
    expect(matchesItemFilter({ score: true }, { score: { $gt: 0 } })).toBe(false);
    expect(matchesItemFilter({ score: null }, { score: { $gte: 0 } })).toBe(false);
    expect(matchesItemFilter({ score: "" }, { score: { $lte: 5 } })).toBe(false);
    expect(matchesItemFilter({ score: [1] }, { score: { $gt: 0 } })).toBe(false);
    expect(matchesItemFilter({ score: { n: 1 } }, { score: { $gt: 0 } })).toBe(false);
  });

  it("excludes NaN from every ordering comparison", () => {
    expect(matchesItemFilter({ score: Number.NaN }, { score: { $gte: 0 } })).toBe(false);
    expect(matchesItemFilter({ score: 5 }, { score: { $gte: Number.NaN } })).toBe(false);
  });

  it("treats an absent key the way JS treats undefined", () => {
    expect(matchesItemFilter({}, { topic: { $ne: "coffee" } })).toBe(true);
    expect(matchesItemFilter({}, { topic: { $nin: ["coffee"] } })).toBe(true);
    expect(matchesItemFilter({}, { topic: { $eq: "coffee" } })).toBe(false);
    expect(matchesItemFilter({}, { topic: "coffee" })).toBe(false);
    expect(matchesItemFilter({}, { topic: { $in: ["coffee"] } })).toBe(false);
    expect(matchesItemFilter({}, { score: { $gt: 0 } })).toBe(false);
  });

  it("distinguishes a present null from an absent key", () => {
    expect(matchesItemFilter({ deleted: null }, { deleted: null })).toBe(true);
    expect(matchesItemFilter({}, { deleted: null })).toBe(false);
    expect(matchesItemFilter({ deleted: null }, { deleted: { $nin: [null] } })).toBe(false);
    expect(matchesItemFilter({}, { deleted: { $nin: [null] } })).toBe(true);
  });
});

describe("storeItemFilterProblem", () => {
  it("accepts every shape the drivers can execute", () => {
    for (const filter of [
      {},
      { topic: "coffee" },
      { done: false },
      { deleted: null },
      { score: 5 },
      { score: {} },
      { score: { $gte: 3, $lt: 9 } },
      { topic: { $eq: "tea" }, other: { $ne: null } },
      { topic: { $in: ["tea", 1, null, true] } },
      { topic: { $nin: [] } },
    ]) {
      expect(storeItemFilterProblem(filter)).toBeNull();
    }
  });

  it("refuses an unknown operator, which would state no condition and match everything", () => {
    expect(storeItemFilterProblem({ score: { $gtt: 3 } })).toMatch(/unknown operator "\$gtt"/);
  });

  it("refuses a non-scalar value, which would match nothing on one driver and something on the other", () => {
    expect(storeItemFilterProblem({ tags: ["work"] })).toMatch(/use \$in for membership/);
    expect(storeItemFilterProblem({ meta: { x: 1 } })).toMatch(/use \$in for membership/);
  });

  it("refuses a non-numeric ordering operand, which Postgres cannot cast", () => {
    // `'abc'::numeric` throws where `Number("abc")` merely yields NaN, so an unchecked operand here
    // is a 500 from inside a run rather than an empty result.
    expect(storeItemFilterProblem({ score: { $gt: "3" } })).toMatch(/\$gt must be a number/);
    expect(storeItemFilterProblem({ score: { $gte: null } })).toMatch(/\$gte must be a number/);
    expect(storeItemFilterProblem({ score: { $lt: undefined } })).toMatch(/\$lt must be a number/);
    expect(storeItemFilterProblem({ score: { $lte: Number.NaN } })).toMatch(
      /\$lte must be a number/,
    );
  });

  it("refuses a $in/$nin operand that is not an array of scalars", () => {
    expect(storeItemFilterProblem({ topic: { $in: "abc" } })).toMatch(/array of scalars/);
    expect(storeItemFilterProblem({ topic: { $nin: [{ a: 1 }] } })).toMatch(/array of scalars/);
  });

  it("refuses a filter that is not an object", () => {
    for (const value of [null, "topic", 3, ["topic"]]) {
      expect(storeItemFilterProblem(value)).toMatch(/must be an object/);
    }
  });
});

describe("parseStoreItemFilter", () => {
  it("returns a valid filter unchanged", () => {
    const filter = { score: { $gte: 3 } };
    expect(parseStoreItemFilter(filter)).toBe(filter);
  });

  it("throws a 400 rather than letting a bad operand reach the driver", () => {
    expect(() => parseStoreItemFilter({ score: { $gt: "3" } })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});
