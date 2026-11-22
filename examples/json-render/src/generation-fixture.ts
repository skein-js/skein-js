import { setTimeout as pause } from "node:timers/promises";

import type { PromptRequest } from "./catalog.js";
import type { GenerateText } from "./generation.js";

/** A deterministic SpecStream, including non-idempotent array inserts and an unterminated last line. */
export function fixtureSpecStream(request: PromptRequest): string {
  const profile = /profile|octocat/i.test(request.prompt);
  const recent = /recently pushed|torvalds/i.test(request.prompt);

  const title = profile
    ? "GitHub profile"
    : recent
      ? "Recently pushed repositories"
      : "skein-js/skein-js";

  const dashboard = {
    metrics: {
      type: "Grid",
      props: { columns: 3 },
      children: ["metric_a", "metric_b", "metric_c"],
    },
    metric_a: {
      type: "Metric",
      props: {
        label: recent ? "linux" : "Stars",
        value: recent ? "C" : "124",
        detail: "GitHub repository",
      },
      children: [],
    },
    metric_b: {
      type: "Metric",
      props: {
        label: recent ? "uemacs" : "Forks",
        value: recent ? "C" : "8",
        detail: "GitHub repository",
      },
      children: [],
    },
    metric_c: {
      type: "Metric",
      props: {
        label: recent ? "pesconvert" : "Default branch",
        value: recent ? "C" : "main",
        detail: "GitHub repository",
      },
      children: [],
    },
    table: {
      type: "Table",
      props: {
        caption: recent ? "Recent repositories" : "Repository overview",
        columns: ["Item", "Language", "Branch"],
        rows: recent
          ? [
              ["linux", "C", "master"],
              ["uemacs", "C", "master"],
              ["pesconvert", "C", "master"],
            ]
          : [
              ["Runtime", "TypeScript", "main"],
              ["SDK", "TypeScript", "main"],
              ["Examples", "TypeScript", "main"],
            ],
      },
      children: [],
    },
  };

  const elements = {
    summary: { type: "Text", props: { text: request.prompt }, children: [] },
    ...(profile ? {} : dashboard),
    tasks: { type: "TaskList", props: { tasks: [] }, children: [] },
    revise: {
      type: "Button",
      props: {
        label: "Make it simpler",
        prompt: ("Make this UI simpler: " + request.prompt).slice(0, 2000),
      },
      children: [],
    },
    feedback: {
      type: "FeedbackForm",
      props: { label: "What would you change?" },
      children: [],
    },
  };

  const patches: unknown[] = [
    { op: "add", path: "/root", value: "plan" },
    {
      op: "add",
      path: "/elements",
      value: { plan: { type: "Card", props: { title }, children: [] } },
    },
  ];

  for (const [key, element] of Object.entries(elements)) {
    patches.push({ op: "add", path: "/elements/" + key, value: element });
    if (!key.startsWith("metric_"))
      patches.push({ op: "add", path: "/elements/plan/children/-", value: key });
  }

  for (const task of [
    "Explore the generated components",
    "Ask for a change in the chat or form",
    "Review the next version",
  ]) {
    patches.push({ op: "add", path: "/elements/tasks/props/tasks/-", value: task });
  }

  return patches.map((patch) => JSON.stringify(patch)).join("\n");
}

export const generateFixtureText: GenerateText = async function* (request, signal) {
  const text = fixtureSpecStream(request);

  // Split inside JSON lines rather than treating a transport chunk as a patch boundary.
  for (let offset = 0; offset < text.length; offset += 180) {
    await pause(70, undefined, { signal });
    yield text.slice(offset, offset + 180);
  }
};
