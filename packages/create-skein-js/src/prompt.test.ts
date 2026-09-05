// The prompt helpers, driven by a fake `ask` — the testability the module's own header promises.

import { describe, expect, it } from "vitest";

import { canPrompt, promptChoice, promptConfirm, promptText } from "./prompt.js";

/** An `AskQuestion` that replays canned answers and records what it was asked. */
function answering(...answers: string[]) {
  const asked: string[] = [];
  let next = 0;
  return {
    asked,
    ask: async (query: string) => {
      asked.push(query);
      return answers[next++] ?? "";
    },
  };
}

describe("promptConfirm", () => {
  it("accepts the spellings a person actually types", async () => {
    for (const yes of ["y", "Y", "yes", "YES", " yes "]) {
      expect(await promptConfirm(answering(yes).ask, "?", false)).toBe(true);
    }
    for (const no of ["n", "N", "no", "NO", " no "]) {
      expect(await promptConfirm(answering(no).ask, "?", true)).toBe(false);
    }
  });

  it("takes the default on an empty or unrecognised answer", async () => {
    // Same forgiveness as `promptChoice`: a stray keystroke in the middle of a scaffold should not
    // be an error, and the default is always the safe answer.
    expect(await promptConfirm(answering("").ask, "?", true)).toBe(true);
    expect(await promptConfirm(answering("").ask, "?", false)).toBe(false);
    expect(await promptConfirm(answering("maybe").ask, "?", true)).toBe(true);
    expect(await promptConfirm(answering("maybe").ask, "?", false)).toBe(false);
  });

  it("shows which way it will go if you just press enter", async () => {
    const yesDefault = answering("");
    await promptConfirm(yesDefault.ask, "Install dependencies?", true);
    expect(yesDefault.asked[0]).toContain("Y/n");

    const noDefault = answering("");
    await promptConfirm(noDefault.ask, "Initialize a git repository?", false);
    expect(noDefault.asked[0]).toContain("y/N");
  });
});

describe("canPrompt", () => {
  it("refuses when --yes was passed, whatever the terminal looks like", () => {
    // The other two conditions are ambient (TTY, CI) and not ours to fake here; this is the one a
    // caller controls, and the one that has to hold for `-y` to mean "never ask".
    expect(canPrompt({ yes: true })).toBe(false);
  });
});

describe("promptText and promptChoice still take their defaults", () => {
  it("falls back on empty input", async () => {
    expect(await promptText(answering("").ask, "Project directory", "my-agent")).toBe("my-agent");
    const choices = [
      { value: "memory", label: "In memory" },
      { value: "postgres", label: "Postgres + Redis" },
    ] as const;
    expect(await promptChoice(answering("").ask, "Storage?", choices, "memory")).toBe("memory");
    expect(await promptChoice(answering("2").ask, "Storage?", choices, "memory")).toBe("postgres");
  });
});
