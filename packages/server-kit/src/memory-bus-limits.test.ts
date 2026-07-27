import { SkeinConfigError } from "@skein-js/config";
import {
  DEFAULT_MEMORY_BUS_MAX_FRAMES_PER_RUN,
  DEFAULT_MEMORY_BUS_MAX_RETAINED_RUNS,
} from "@skein-js/storage-memory";
import { describe, expect, it } from "vitest";

import { resolveMemoryBusLimits } from "./memory-bus-limits.js";

describe("resolveMemoryBusLimits", () => {
  it("falls back to the defaults when nothing is configured", () => {
    expect(resolveMemoryBusLimits({}, {})).toEqual({
      maxRetainedRuns: DEFAULT_MEMORY_BUS_MAX_RETAINED_RUNS,
      maxFramesPerRun: DEFAULT_MEMORY_BUS_MAX_FRAMES_PER_RUN,
    });
  });

  it("reads each bound from its environment variable", () => {
    expect(
      resolveMemoryBusLimits(
        {},
        { SKEIN_MEMORY_BUS_MAX_RETAINED_RUNS: "20", SKEIN_MEMORY_BUS_MAX_FRAMES_PER_RUN: "500" },
      ),
    ).toEqual({ maxRetainedRuns: 20, maxFramesPerRun: 500 });
  });

  it("lets an explicit value win over the environment", () => {
    expect(
      resolveMemoryBusLimits(
        { maxFramesPerRun: 10 },
        { SKEIN_MEMORY_BUS_MAX_FRAMES_PER_RUN: "500" },
      ).maxFramesPerRun,
    ).toBe(10);
  });

  it("treats a blank variable as unset rather than as zero", () => {
    // `Number("")` is 0, which would otherwise fail validation and report a confusing
    // 'must be a positive integer (got "")' for a variable the user effectively left empty.
    expect(resolveMemoryBusLimits({}, { SKEIN_MEMORY_BUS_MAX_RETAINED_RUNS: "  " })).toEqual({
      maxRetainedRuns: DEFAULT_MEMORY_BUS_MAX_RETAINED_RUNS,
      maxFramesPerRun: DEFAULT_MEMORY_BUS_MAX_FRAMES_PER_RUN,
    });
  });

  it("rejects a malformed environment value even when an explicit value is also given", () => {
    // The point of validating regardless: a typo in a deployment's environment must fail the boot,
    // not sit unnoticed because some caller happened to pass the option too.
    expect(() =>
      resolveMemoryBusLimits(
        { maxRetainedRuns: 10 },
        { SKEIN_MEMORY_BUS_MAX_RETAINED_RUNS: "lots" },
      ),
    ).toThrow(SkeinConfigError);
  });

  it.each([
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["non-numeric", "many"],
  ])("rejects a %s bound", (_label, raw) => {
    expect(() => resolveMemoryBusLimits({}, { SKEIN_MEMORY_BUS_MAX_FRAMES_PER_RUN: raw })).toThrow(
      SkeinConfigError,
    );
  });
});
