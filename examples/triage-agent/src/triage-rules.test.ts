import { AIMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { describe, expect, it, vi } from "vitest";

import { classify } from "./classifier.js";
import { requireGoogleApiKey } from "./model.js";
import { routeSweep } from "./sweep-graph.js";
import { applyCritique, routeForApproval } from "./triage-graph.js";
import type { TriageItem, Verdict } from "./triage-sources.js";

vi.hoisted(() => {
  vi.stubEnv("GOOGLE_API_KEY", "test-key");
});

const item = (overrides: Partial<TriageItem> = {}): TriageItem => ({
  sourceId: "1",
  title: "",
  body: "",
  url: "",
  author: "someone",
  labels: [],
  ...overrides,
});

const verdict = (overrides: Partial<Verdict> = {}): Verdict => ({
  category: "question",
  severity: "low",
  reply: "",
  reasoning: "",
  ...overrides,
});

describe("Gemini classifier", () => {
  it("uses the model's structured verdict", async () => {
    const expected = verdict({ category: "bug", severity: "high", reply: "Thanks for the report" });

    const generate = vi.spyOn(ChatGoogleGenerativeAI.prototype, "_generate").mockResolvedValue({
      generations: [
        {
          message: new AIMessage(JSON.stringify(expected)),
          text: JSON.stringify(expected),
        },
      ],
    });

    try {
      const input = { item: item({ title: "Crash on startup" }), conventions: [], related: [] };
      const result = await classify(input, {});
      expect(result.verdict).toEqual(expected);
      expect(generate).toHaveBeenCalledOnce();
    } finally {
      generate.mockRestore();
    }
  });

  it.each([undefined, "   "])("requires a nonblank Gemini key (%j)", (key) => {
    vi.stubEnv("GOOGLE_API_KEY", key);

    try {
      expect(() => requireGoogleApiKey()).toThrow("Set GOOGLE_API_KEY");
    } finally {
      vi.stubEnv("GOOGLE_API_KEY", "test-key");
    }
  });
});

describe("critique", () => {
  it("strips a reply the classifier drafted for spam", () => {
    const corrected = applyCritique({
      verdict: verdict({ category: "spam", severity: "high", reply: "Thanks for reaching out!" }),
    });
    expect(corrected.verdict?.reply).toBe("");
    expect(corrected.verdict?.severity).toBe("low");
  });

  it("downgrades a high-severity question, which is a contradiction in terms", () => {
    const corrected = applyCritique({
      verdict: verdict({ category: "question", severity: "high" }),
    });
    expect(corrected.verdict?.severity).toBe("medium");
  });

  it("leaves a coherent verdict alone", () => {
    const original = verdict({ category: "bug", severity: "high", reply: "on it" });
    expect(applyCritique({ verdict: original }).verdict).toEqual(original);
  });
});

describe("routeForApproval", () => {
  it("never auto-records a bug, however minor it looks", () => {
    // Wrongly ignoring a bug costs far more than one extra approval.
    expect(routeForApproval({ verdict: verdict({ category: "bug", severity: "low" }) })).toBe(
      "approve",
    );
  });

  it("records spam and low-severity chatter without asking", () => {
    expect(routeForApproval({ verdict: verdict({ category: "spam" }) })).toBe("record");
    expect(routeForApproval({ verdict: verdict({ category: "question", severity: "low" }) })).toBe(
      "record",
    );
  });

  it("asks about anything with real severity", () => {
    expect(
      routeForApproval({ verdict: verdict({ category: "feature", severity: "medium" }) }),
    ).toBe("approve");
  });

  it("asks when there is no verdict at all", () => {
    expect(routeForApproval({})).toBe("approve");
  });
});

describe("routeSweep", () => {
  it("skips the dispatch step entirely when nothing is new", () => {
    // The common case for a healthy queue, and it should cost nothing — no client, no HTTP.
    expect(routeSweep({ fresh: [] } as never)).toBe("report");
  });

  it("dispatches when there is fresh work", () => {
    expect(routeSweep({ fresh: [item()] } as never)).toBe("dispatch");
  });
});
