import { describe, expect, it } from "vitest";

import {
  dedupeKey,
  normalizeGitHubIssues,
  parseVerdict,
  requireTriageItem,
  threadIdFor,
} from "./triage-sources.js";

describe("normalizeGitHubIssues", () => {
  it("drops pull requests, which the issues endpoint also returns", () => {
    const items = normalizeGitHubIssues([
      { number: 1, title: "a bug", body: "x", html_url: "u", user: { login: "a" }, labels: [] },
      {
        number: 2,
        title: "a PR",
        body: "y",
        html_url: "v",
        user: { login: "b" },
        labels: [],
        pull_request: {},
      },
    ]);
    expect(items.map((item) => item.sourceId)).toEqual(["1"]);
  });

  it("accepts labels in both shapes GitHub uses", () => {
    const [item] = normalizeGitHubIssues([
      {
        number: 3,
        title: "t",
        body: null,
        html_url: "u",
        user: null,
        labels: ["bug", { name: "p1" }, {}],
      },
    ]);
    expect(item?.labels).toEqual(["bug", "p1"]);
    expect(item?.author).toBe("unknown");
    expect(item?.body).toBe("");
  });

  it("bounds the body so a huge issue cannot blow up the prompt", () => {
    const [item] = normalizeGitHubIssues([
      { number: 4, title: "t", body: "x".repeat(9000), html_url: "u", user: null, labels: [] },
    ]);
    expect(item?.body).toHaveLength(4000);
  });

  it("returns nothing for a payload that is not a list", () => {
    expect(normalizeGitHubIssues({ message: "Not Found" })).toEqual([]);
    expect(normalizeGitHubIssues(null)).toEqual([]);
  });
});

describe("dedupeKey", () => {
  it("is stable for the same item and scoped by source", () => {
    const item = { sourceId: "42", title: "", body: "", url: "", author: "", labels: [] };
    expect(dedupeKey("github", item)).toBe("github:42");
    // Two sources numbering from 1 must not collide — this key is what makes a re-sweep replay
    // rather than re-triage.
    expect(dedupeKey("rss", item)).not.toBe(dedupeKey("github", item));
  });
});

describe("parseVerdict", () => {
  it("reads a bare JSON object", () => {
    expect(
      parseVerdict('{"category":"bug","severity":"high","reply":"hi","reasoning":"r"}'),
    ).toEqual({ category: "bug", severity: "high", reply: "hi", reasoning: "r" });
  });

  it("reads JSON out of a code fence, which models emit about half the time", () => {
    const raw =
      'Sure!\n```json\n{"category":"docs","severity":"low","reply":"","reasoning":""}\n```';
    expect(parseVerdict(raw).category).toBe("docs");
  });

  it("falls back to a low-severity question rather than throwing", () => {
    // A scheduled run must not die at 3am because a model wrapped its answer in prose. The fallback
    // still reaches a human: everything lands in the approval queue either way.
    const verdict = parseVerdict("I think this is probably a bug?");
    expect(verdict.category).toBe("question");
    expect(verdict.severity).toBe("low");
    expect(verdict.reasoning).toContain("Could not parse");
  });

  it("rejects categories and severities outside the allowed set", () => {
    const verdict = parseVerdict('{"category":"URGENT","severity":"critical","reply":"r"}');
    expect(verdict.category).toBe("question");
    expect(verdict.severity).toBe("low");
    expect(verdict.reply).toBe("r");
  });
});

describe("requireTriageItem", () => {
  it("accepts a complete item and applies defaults", () => {
    expect(requireTriageItem({ sourceId: "7", title: "Login is broken" })).toEqual({
      sourceId: "7",
      title: "Login is broken",
      body: "",
      url: "",
      author: "unknown",
      labels: [],
    });
  });

  it("explains itself when the run was started with no item at all", () => {
    // The case that produced `Cannot read properties of undefined (reading 'title')` three nodes
    // later: a chat-shaped input sent to a graph that triages one item.
    try {
      requireTriageItem(undefined);
      throw new Error("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect((error as Error).name).toBe("TriageInputError");
      // Names the shape it wanted, and the likely mistake.
      expect(message).toContain('"sourceId"');
      expect(message).toContain("messages channel");
      expect(message).not.toContain("reading 'title'");
    }
  });

  it("names the offending field when part of the item is wrong", () => {
    try {
      requireTriageItem({ sourceId: "", title: 42 });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("sourceId");
      expect((error as Error).message).toContain("title");
    }
  });
});

describe("threadIdFor", () => {
  it("is stable for a key, which is what makes a re-sweep replay", () => {
    // The subtle failure this exists to prevent: `ifExists: "do_nothing"` only means anything when a
    // `threadId` is supplied. Without one the server mints a fresh UUID every sweep, the item lands on
    // a new thread, and the Idempotency-Key — which is scoped to its thread — never matches. The
    // sweep looked like it worked and replayed nothing.
    expect(threadIdFor("github:42")).toBe(threadIdFor("github:42"));
    expect(threadIdFor("github:42")).not.toBe(threadIdFor("github:43"));
  });

  it("is a well-formed v5-shaped UUID, which the server requires", () => {
    expect(threadIdFor("fixture:411")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
