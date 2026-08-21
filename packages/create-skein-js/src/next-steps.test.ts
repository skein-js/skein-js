import { describe, expect, it } from "vitest";

import { describeNextSteps } from "./next-steps.js";
import type { ScaffoldOptions } from "./scaffold-options.js";

function optionsFor(overrides: Partial<ScaffoldOptions> = {}): ScaffoldOptions {
  return {
    projectName: "my-agent",
    packageName: "my-agent",
    provider: "none",
    packageManager: "pnpm",
    skeinVersionRange: "^0.14.0",
    ...overrides,
  };
}

const outcome = { relativeDirectory: "my-agent", installed: true };

describe("describeNextSteps", () => {
  it("spells scripts for the chosen package manager", () => {
    const pnpm = describeNextSteps(optionsFor(), outcome).join("\n");
    expect(pnpm).toContain("pnpm dev");

    const npm = describeNextSteps(optionsFor({ packageManager: "npm" }), outcome).join("\n");
    expect(npm).toContain("npm run dev");
  });

  it("adds the install step back when the install did not happen", () => {
    const skipped = describeNextSteps(optionsFor(), { ...outcome, installed: false }).join("\n");
    expect(skipped).toContain("pnpm install");

    const installed = describeNextSteps(optionsFor(), outcome).join("\n");
    expect(installed).not.toContain("pnpm install");
  });

  it("omits `cd` when scaffolding into the current directory", () => {
    const here = describeNextSteps(optionsFor(), { ...outcome, relativeDirectory: "." }).join("\n");
    expect(here).not.toContain("cd ");
  });

  // The scaffolder writes .env itself and preserves an existing one. Advising a copy over the top
  // would destroy the credentials that preservation exists to protect.
  it("never tells you to copy over your .env", () => {
    const withProvider = describeNextSteps(optionsFor({ provider: "anthropic" }), outcome).join(
      "\n",
    );
    expect(withProvider).not.toMatch(/cp .*\.env/);
    expect(withProvider).toContain("ANTHROPIC_API_KEY");
  });

  // A dim footnote after the URLs is a footnote people scroll past, and the cost of scrolling past
  // it is a graph that fails to load on first boot. It belongs in the numbered sequence, before the
  // command it is a prerequisite for.
  it("lists the key as a step before `dev`, and says where to get one", () => {
    const lines = describeNextSteps(optionsFor({ provider: "google" }), outcome);
    const keyStep = lines.findIndex((line) => line.includes("Set GOOGLE_API_KEY in .env"));
    const devStep = lines.findIndex((line) => line.includes("pnpm dev"));

    expect(keyStep).toBeGreaterThanOrEqual(0);
    expect(keyStep).toBeLessThan(devStep);
    expect(lines.join("\n")).toContain("https://aistudio.google.com/apikey");
  });

  it("says nothing about keys when there is no model graph", () => {
    const keyless = describeNextSteps(optionsFor(), outcome).join("\n");
    expect(keyless).not.toContain("API_KEY");
  });

  it("reports a package rename rather than doing it silently", () => {
    const renamed = describeNextSteps(optionsFor({ projectName: "My Agent" }), {
      ...outcome,
      renamedPackageTo: "my-agent",
    }).join("\n");
    expect(renamed).toContain("my-agent");
    expect(renamed).toContain("package.json");
  });
});
