import { describe, expect, it, vi } from "vitest";

import { resolveLinting } from "./resolve-linting.js";

describe("default tooling prompt", () => {
  it.each([true, false])("explicit %s bypasses interactive prompting", async (explicit) => {
    const ask = vi.fn(async () => "n");
    expect(await resolveLinting({ explicit, interactive: true, ask })).toBe(explicit);
    expect(ask).not.toHaveBeenCalled();
  });
  it("defaults on without a TTY", async () => {
    const ask = vi.fn(async () => "n");
    expect(await resolveLinting({ interactive: false, ask })).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
  it.each([
    ["", true],
    ["y", true],
    ["n", false],
  ] as const)("answers %s -> %s", async (answer, expected) => {
    const ask = vi.fn(async () => answer);
    expect(await resolveLinting({ interactive: true, ask })).toBe(expected);
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("Y/n"));
  });
});
