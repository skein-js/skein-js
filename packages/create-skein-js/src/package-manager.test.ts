import { describe, expect, it } from "vitest";

import { resolvePackageManager } from "./package-manager.js";

describe("resolvePackageManager", () => {
  it.each([
    ["pnpm/9.15.0 npm/? node/v22.11.0 darwin arm64", "pnpm"],
    ["npm/10.9.0 node/v22.11.0 darwin arm64 workspaces/false", "npm"],
    ["yarn/4.5.3 npm/? node/v22.11.0", "yarn"],
    ["bun/1.1.38 npm/? node/v22.6.0", "bun"],
  ] as const)("reads %o as %s", (userAgent, expected) => {
    expect(resolvePackageManager(userAgent)).toBe(expected);
  });

  // Run directly rather than through a package manager, so there is no user agent to read.
  it("falls back to npm when the user agent is absent or unrecognised", () => {
    expect(resolvePackageManager(undefined)).toBe("npm");
    expect(resolvePackageManager("")).toBe("npm");
    expect(resolvePackageManager("deno/2.1.4")).toBe("npm");
  });
});
