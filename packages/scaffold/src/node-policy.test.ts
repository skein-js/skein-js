import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { RECOMMENDED_NODE_MAJOR, SUPPORTED_NODE_RANGE, resolveNodeVersion } from "./node-policy.js";

describe("Node policy", () => {
  it("matches the reusable CI baseline", () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, "../../../.github/workflows/ci.yml"),
      "utf8",
    );
    expect(workflow.match(/NODE_LTS: (\d+)/)?.[1]).toBe(RECOMMENDED_NODE_MAJOR);
    expect(SUPPORTED_NODE_RANGE).toBe("^22.12.0 || ^24.0.0 || ^26.0.0");
  });
  it.each(["22", "22.12", "22.12.0", "v24.15.0", "24", "26", "26.0", "26.0.0", "v26.12.0"])(
    "honors compatible pin %s",
    (pin) => {
      expect(resolveNodeVersion(pin).version).toBe(pin.replace(/^v/, ""));
    },
  );
  it.each(["20", "22.11", "23", "25", "27"])("rejects unsupported pin %s", (pin) => {
    expect(() => resolveNodeVersion(pin)).toThrow(/unsupported/);
  });
  it("keeps Node 24 as the default", () => {
    expect(resolveNodeVersion(undefined)).toEqual({ version: "24" });
  });
  it("explains unresolved aliases", () => {
    expect(resolveNodeVersion("lts/*")).toEqual({
      version: "24",
      notice: expect.stringContaining("offline"),
    });
  });
});
