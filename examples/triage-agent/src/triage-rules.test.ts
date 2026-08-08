// The graph's actual judgement: how it classifies offline, what it corrects, and when it decides a
// human needs to see something. These are the decisions the example is *about*, so they get tests
// rather than a live run and a shrug.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createClassifier } from "./classifier.js";
import { routeSweep } from "./sweep-graph.js";
import { applyCritique, routeForApproval } from "./triage-graph.js";
import { fixtureIssues, type TriageItem, type Verdict } from "./triage-sources.js";

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

describe("offline classifier", () => {
  let previousKey: string | undefined;

  beforeEach(() => {
    previousKey = process.env["GOOGLE_API_KEY"];
    delete process.env["GOOGLE_API_KEY"];
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env["GOOGLE_API_KEY"];
    else process.env["GOOGLE_API_KEY"] = previousKey;
  });

  it("is selected when no model key is present, and says so", async () => {
    const classifier = createClassifier();
    expect(classifier.kind).toBe("rules");
    const result = await classifier.classify(item({ title: "anything" }), {
      conventions: [],
      related: [],
    });
    // Nobody should be able to mistake a rules verdict for a model one.
    expect(result.reasoning).toContain("No model was called");
  });

  it("classifies the bundled fixtures the way a human would", async () => {
    const classifier = createClassifier();
    const issues = fixtureIssues(10);
    const byTitle = new Map<string, Verdict>();
    for (const issue of issues) {
      byTitle.set(issue.title, await classifier.classify(issue, { conventions: [], related: [] }));
    }

    const crash = byTitle.get(
      "Crash on startup: Cannot read properties of undefined (reading 'graphs')",
    );
    expect(crash?.category).toBe("bug");
    // "Production is down" is the phrase that should escalate it.
    expect(crash?.severity).toBe("high");

    expect(byTitle.get("Add support for streaming tool call arguments")?.category).toBe("feature");
    expect(byTitle.get("How do I run two instances behind a load balancer?")?.category).toBe(
      "question",
    );
    expect(
      byTitle.get("Docs: `http.console` is not mentioned in the langgraph.json reference")
        ?.category,
    ).toBe("docs");
    expect(byTitle.get("🔥🔥 BUY CHEAP FOLLOWERS NOW visit my site 🔥🔥")?.category).toBe("spam");
  });

  it("is deterministic, which is what makes any of this testable", async () => {
    const classifier = createClassifier();
    const subject = item({ title: "Intermittent 500 under load", body: "fails sometimes" });
    const first = await classifier.classify(subject, { conventions: [], related: [] });
    const second = await classifier.classify(subject, { conventions: [], related: [] });
    expect(first).toEqual(second);
  });
});

describe("critique", () => {
  it("strips a reply the classifier drafted for spam", () => {
    const corrected = applyCritique({
      verdict: verdict({ category: "spam", severity: "high", reply: "Thanks for reaching out!" }),
    } as never);
    expect(corrected.verdict?.reply).toBe("");
    expect(corrected.verdict?.severity).toBe("low");
  });

  it("downgrades a high-severity question, which is a contradiction in terms", () => {
    const corrected = applyCritique({
      verdict: verdict({ category: "question", severity: "high" }),
    } as never);
    expect(corrected.verdict?.severity).toBe("medium");
  });

  it("leaves a coherent verdict alone", () => {
    const original = verdict({ category: "bug", severity: "high", reply: "on it" });
    expect(applyCritique({ verdict: original } as never).verdict).toEqual(original);
  });
});

describe("routeForApproval", () => {
  it("never auto-records a bug, however minor it looks", () => {
    // Wrongly ignoring a bug costs far more than one extra approval.
    expect(
      routeForApproval({ verdict: verdict({ category: "bug", severity: "low" }) } as never),
    ).toBe("approve");
  });

  it("records spam and low-severity chatter without asking", () => {
    expect(routeForApproval({ verdict: verdict({ category: "spam" }) } as never)).toBe("record");
    expect(
      routeForApproval({ verdict: verdict({ category: "question", severity: "low" }) } as never),
    ).toBe("record");
  });

  it("asks about anything with real severity", () => {
    expect(
      routeForApproval({ verdict: verdict({ category: "feature", severity: "medium" }) } as never),
    ).toBe("approve");
  });

  it("asks when there is no verdict at all", () => {
    expect(routeForApproval({} as never)).toBe("approve");
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
