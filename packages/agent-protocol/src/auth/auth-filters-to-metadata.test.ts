// The pushdown is only safe if it never excludes a row `matchesFilters` would accept — a clause that is
// too strict silently hides rows a caller owns, and nothing downstream can notice. So rather than
// asserting the translated shapes in isolation, most of this walks a matrix of (metadata, filters) pairs
// and checks the driver predicate against the real engine's predicate directly.

import { isMetadataSubset, type AuthFilters, type Metadata } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { authFiltersToMetadataSubset } from "./auth-filters-to-metadata.js";

// `matchesFilters` delegates to `isAuthMatching`; reproduced here so the matrix runs without loading an
// auth engine. Any drift between this and the real one is caught by `auth-scoped-store.test.ts`, which
// exercises the engine end to end.
function isAuthMatching(metadata: Metadata | undefined, filters?: AuthFilters): boolean {
  if (filters == null) return true;
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "object" && value != null) {
      if (value.$eq) {
        if (metadata?.[key] !== value.$eq) return false;
      } else if (value.$contains) {
        const stored = metadata?.[key];
        if (!Array.isArray(stored)) return false;
        const wanted = Array.isArray(value.$contains) ? value.$contains : [value.$contains];
        if (!wanted.every((one) => stored.includes(one))) return false;
      }
    } else if (metadata?.[key] !== value) {
      return false;
    }
  }
  return true;
}

/** What the drivers do with the translated subset (`metadata @> …` / `isMetadataSubset`). */
function driverAccepts(metadata: Metadata | undefined, filters?: AuthFilters): boolean {
  return isMetadataSubset(metadata, authFiltersToMetadataSubset(filters));
}

const FILTER_CASES: AuthFilters[] = [
  { owner: "alice" },
  { owner: { $eq: "alice" } },
  { tags: { $contains: "red" } },
  { tags: { $contains: ["red", "blue"] } },
  { owner: "alice", tags: { $contains: "red" } },
  // Operator objects `isAuthMatching` ignores because the operand is falsy or absent.
  { owner: { $eq: "" } },
  { owner: {} },
  { owner: { $contains: "" } },
  // A falsy *plain* value still constrains — `!==` against `""`.
  { owner: "" },
  // Off-type but reachable: an auth handler returning `{ owner: user.metadata?.org }` for a user with no
  // org. The types don't stop it and `authorize` passes the handler's object through verbatim. This is
  // the class of value that actually arrives from user code, so the matrix has to include it.
  { owner: undefined } as unknown as AuthFilters,
];

const METADATA_CASES: (Metadata | undefined)[] = [
  undefined,
  {},
  { owner: "alice" },
  { owner: "bob" },
  { owner: "" },
  { owner: null },
  { tags: ["red"] },
  { tags: ["red", "blue"] },
  { tags: ["blue"] },
  { tags: "red" }, // a string where $contains wants an array
  { tags: [] },
  { owner: "alice", tags: ["red", "blue"] },
  { owner: "alice", tags: [] },
  { owner: { $eq: "alice" } }, // metadata that mimics a filter clause
];

describe("authFiltersToMetadataSubset", () => {
  // The load-bearing property. If this ever fails, an auth-enabled deployment is losing rows.
  it("never excludes a row the auth engine would accept", () => {
    const wronglyExcluded: string[] = [];
    for (const filters of FILTER_CASES) {
      for (const metadata of METADATA_CASES) {
        if (isAuthMatching(metadata, filters) && !driverAccepts(metadata, filters)) {
          wronglyExcluded.push(`${JSON.stringify(filters)} vs ${JSON.stringify(metadata)}`);
        }
      }
    }
    expect(wronglyExcluded).toEqual([]);
  });

  // Not required for correctness (the JS filter narrows afterwards), but it is the whole point of the
  // pushdown: a translation that accepted everything would be safe and useless. Only the clauses
  // `isAuthMatching` itself ignores may over-accept.
  it("matches the auth engine exactly for every expressible filter", () => {
    const expressible = FILTER_CASES.filter(
      (filters) => authFiltersToMetadataSubset(filters) !== undefined,
    );
    const divergent: string[] = [];
    for (const filters of expressible) {
      for (const metadata of METADATA_CASES) {
        if (isAuthMatching(metadata, filters) !== driverAccepts(metadata, filters)) {
          divergent.push(`${JSON.stringify(filters)} vs ${JSON.stringify(metadata)}`);
        }
      }
    }
    expect(divergent).toEqual([]);
  });

  it("translates a plain value and $eq to the same equality subset", () => {
    expect(authFiltersToMetadataSubset({ owner: "alice" })).toEqual({ owner: "alice" });
    expect(authFiltersToMetadataSubset({ owner: { $eq: "alice" } })).toEqual({ owner: "alice" });
  });

  // Wrapped in an array so containment means "the stored array holds this", not "the stored value is
  // this" — `{ tags: "red" }` would match a plain string and miss the array it is meant to match.
  it("wraps $contains in an array", () => {
    expect(authFiltersToMetadataSubset({ tags: { $contains: "red" } })).toEqual({ tags: ["red"] });
    expect(authFiltersToMetadataSubset({ tags: { $contains: ["red", "blue"] } })).toEqual({
      tags: ["red", "blue"],
    });
  });

  it("emits nothing for filters the engine imposes no constraint from", () => {
    expect(authFiltersToMetadataSubset(undefined)).toBeUndefined();
    expect(authFiltersToMetadataSubset({})).toBeUndefined();
    expect(authFiltersToMetadataSubset({ owner: { $eq: "" } })).toBeUndefined();
    expect(authFiltersToMetadataSubset({ owner: {} })).toBeUndefined();
  });

  // The drivers would disagree about this one in *opposite* directions: `isMetadataSubset` needs the key
  // present-and-undefined so it matches nothing, while `JSON.stringify` drops it so `metadata @> '{}'`
  // matches everything. Skipping it is the only answer that is broad on both.
  it("skips an undefined clause value rather than emitting a key", () => {
    expect(
      authFiltersToMetadataSubset({ owner: undefined } as unknown as AuthFilters),
    ).toBeUndefined();
    expect(
      authFiltersToMetadataSubset({ owner: "alice", org: undefined } as unknown as AuthFilters),
    ).toEqual({ owner: "alice" });
  });

  // The "errs broad" claim in the header needs an exercised example, not just the empty-subset cases:
  // `$contains` with an object operand is deep containment here but reference identity in the engine, so
  // the driver accepts a row the engine then rejects — which the in-process filter is there to catch.
  it("errs broad rather than strict when it cannot match the engine exactly", () => {
    const filters = { tags: { $contains: [{ id: 1 }] } } as unknown as AuthFilters;
    const metadata: Metadata = { tags: [{ id: 1 }] };

    expect(isAuthMatching(metadata, filters)).toBe(false);
    expect(driverAccepts(metadata, filters)).toBe(true);
  });

  it("keeps the expressible clauses of a mixed filter and drops the rest", () => {
    expect(authFiltersToMetadataSubset({ owner: "alice", ignored: { $eq: "" } })).toEqual({
      owner: "alice",
    });
  });
});
