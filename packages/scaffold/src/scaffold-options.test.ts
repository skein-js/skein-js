import { describe, expect, it } from "vitest";

import { isModelProvider, isPackageManagerName, toPackageName } from "./scaffold-options.js";

describe("toPackageName", () => {
  it.each([
    ["my-agent", "my-agent"],
    ["My Agent", "my-agent"],
    ["  Weather Bot  ", "weather-bot"],
    ["agent@2", "agent2"],
    // npm reserves leading dots and underscores.
    ["_internal", "internal"],
    [".hidden", "hidden"],
    // Nothing legal survives, so fall back rather than emit an invalid manifest.
    ["!!!", "skein-agent"],
    ["", "skein-agent"],
  ])("turns %o into %o", (input, expected) => {
    expect(toPackageName(input)).toBe(expected);
  });
});

describe("option guards", () => {
  it("accepts the providers we can scaffold", () => {
    expect(isModelProvider("google")).toBe(true);
    expect(isModelProvider("gemini")).toBe(false);
  });

  it("accepts the package managers we can detect", () => {
    expect(isPackageManagerName("pnpm")).toBe(true);
    expect(isPackageManagerName("cargo")).toBe(false);
  });
});
