import { describe, expect, it } from "vitest";

import { version } from "../package.json";

import { resolveSkeinVersionRange, scaffolderVersion } from "./skein-version.js";

describe("release version", () => {
  it("pins the runtime to the scaffolder release", () => {
    expect(scaffolderVersion).toBe(version);
    expect(resolveSkeinVersionRange()).toBe("^" + version);
  });
});
