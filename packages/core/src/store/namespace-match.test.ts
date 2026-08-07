import { describe, expect, it } from "vitest";

import {
  compareNamespaces,
  hasNamespaceWildcard,
  matchesNamespacePrefix,
  matchesNamespaceQuery,
  matchesNamespaceSuffix,
  truncateNamespaceDepth,
} from "./namespace-match.js";

describe("matchesNamespacePrefix", () => {
  it("matches a concrete prefix and narrows on the first segment", () => {
    expect(matchesNamespacePrefix(["users", "1"], ["users"])).toBe(true);
    expect(matchesNamespacePrefix(["orgs", "1"], ["users"])).toBe(false);
  });

  it("lets a wildcard stand for any one segment", () => {
    expect(matchesNamespacePrefix(["users", "1"], ["users", "*"])).toBe(true);
    expect(matchesNamespacePrefix(["users", "2"], ["users", "*"])).toBe(true);
    expect(matchesNamespacePrefix(["orgs", "1"], ["users", "*"])).toBe(false);
  });

  it("still matches when the namespace is deeper than the path", () => {
    // The reason a wildcard prefix narrows a *subtree*: it is not a depth selector.
    expect(matchesNamespacePrefix(["users", "1", "memories"], ["users", "*"])).toBe(true);
  });

  it("matches a wildcard in a non-terminal position", () => {
    expect(matchesNamespacePrefix(["users", "1"], ["*", "1"])).toBe(true);
    expect(matchesNamespacePrefix(["users", "2"], ["*", "1"])).toBe(false);
  });

  it("never matches a path longer than the namespace", () => {
    expect(matchesNamespacePrefix(["users"], ["users", "1"])).toBe(false);
    expect(matchesNamespacePrefix(["users"], ["users", "*"])).toBe(false);
  });

  it("matches a stored literal asterisk segment", () => {
    // Upstream cannot distinguish a literal `*` from the wildcard, and neither may we.
    expect(matchesNamespacePrefix(["users", "*"], ["users", "*"])).toBe(true);
  });

  it("matches everything on an empty path", () => {
    expect(matchesNamespacePrefix(["anything"], [])).toBe(true);
  });
});

describe("matchesNamespaceSuffix", () => {
  it("anchors at the last segment", () => {
    expect(matchesNamespaceSuffix(["users", "1", "facts"], ["facts"])).toBe(true);
    expect(matchesNamespaceSuffix(["users", "1", "facts"], ["1"])).toBe(false);
    expect(matchesNamespaceSuffix(["users", "1", "facts"], ["1", "facts"])).toBe(true);
  });

  it("lets a wildcard stand for any one segment", () => {
    expect(matchesNamespaceSuffix(["users", "1", "facts"], ["*", "facts"])).toBe(true);
    expect(matchesNamespaceSuffix(["users", "1", "facts"], ["*", "notes"])).toBe(false);
  });

  it("never matches a path longer than the namespace", () => {
    expect(matchesNamespaceSuffix(["facts"], ["1", "facts"])).toBe(false);
  });
});

describe("matchesNamespaceQuery", () => {
  it("ANDs prefix and suffix", () => {
    const query = { prefix: ["users", "*"], suffix: ["facts"] };
    expect(matchesNamespaceQuery(["users", "1", "facts"], query)).toBe(true);
    expect(matchesNamespaceQuery(["users", "1", "notes"], query)).toBe(false);
    expect(matchesNamespaceQuery(["orgs", "1", "facts"], query)).toBe(false);
  });

  it("treats an absent or empty query as no filter at all", () => {
    expect(matchesNamespaceQuery(["users", "1"])).toBe(true);
    expect(matchesNamespaceQuery(["users", "1"], {})).toBe(true);
    expect(matchesNamespaceQuery(["users", "1"], { prefix: [], suffix: [] })).toBe(true);
  });
});

describe("hasNamespaceWildcard", () => {
  it("reports whether a path needs the positional matcher", () => {
    expect(hasNamespaceWildcard(["users", "*"])).toBe(true);
    expect(hasNamespaceWildcard(["users", "1"])).toBe(false);
    expect(hasNamespaceWildcard([])).toBe(false);
  });
});

describe("truncateNamespaceDepth", () => {
  it("truncates and de-duplicates, keeping first-seen order", () => {
    expect(
      truncateNamespaceDepth(
        [
          ["users", "1"],
          ["users", "2"],
          ["orgs", "1"],
        ],
        1,
      ),
    ).toEqual([["users"], ["orgs"]]);
  });

  it("leaves namespaces shorter than the depth alone", () => {
    expect(truncateNamespaceDepth([["users"], ["users", "1"]], 2)).toEqual([
      ["users"],
      ["users", "1"],
    ]);
  });

  it("does not collide namespaces whose segments contain a separator", () => {
    expect(truncateNamespaceDepth([["a", "b"], ["a/b"]], 2)).toEqual([["a", "b"], ["a/b"]]);
  });
});

describe("compareNamespaces", () => {
  it("orders element-wise, shorter first on a shared prefix", () => {
    const sorted = [["users", "2"], ["orgs"], ["users"], ["users", "1"]].sort(compareNamespaces);

    expect(sorted).toEqual([["orgs"], ["users"], ["users", "1"], ["users", "2"]]);
  });

  it("reports equality as zero", () => {
    expect(compareNamespaces(["users", "1"], ["users", "1"])).toBe(0);
  });
});
