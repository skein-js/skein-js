// Unlike the other bounds in this area, "unset" is the correct default here — a legitimate agent run
// takes minutes, so a default would turn slow-but-working into killed. These pin that.

import { SkeinConfigError } from "@skein-js/config/errors";
import { describe, expect, it } from "vitest";

import { resolveRunTimeoutMs } from "./run-timeout.js";

describe("resolveRunTimeoutMs", () => {
  it("is undefined when nothing is set — no timeout", () => {
    expect(resolveRunTimeoutMs(undefined, {})).toBeUndefined();
  });

  it("reads SKEIN_RUN_TIMEOUT_MS", () => {
    expect(resolveRunTimeoutMs(undefined, { SKEIN_RUN_TIMEOUT_MS: "300000" })).toBe(300_000);
  });

  it("prefers an explicit value over the environment", () => {
    expect(resolveRunTimeoutMs(60_000, { SKEIN_RUN_TIMEOUT_MS: "300000" })).toBe(60_000);
  });

  it("treats blank as unset", () => {
    expect(resolveRunTimeoutMs(undefined, { SKEIN_RUN_TIMEOUT_MS: "   " })).toBeUndefined();
  });

  it("throws on a malformed or non-positive value", () => {
    expect(() => resolveRunTimeoutMs(undefined, { SKEIN_RUN_TIMEOUT_MS: "soon" })).toThrow(
      SkeinConfigError,
    );
    expect(() => resolveRunTimeoutMs(undefined, { SKEIN_RUN_TIMEOUT_MS: "0" })).toThrow();
    expect(() => resolveRunTimeoutMs(0, {})).toThrow(/runTimeoutMs/);
  });

  // A bad value must not sit unnoticed in a deployment that also passes the option explicitly.
  it("validates the environment even when an explicit value is given", () => {
    expect(() => resolveRunTimeoutMs(60_000, { SKEIN_RUN_TIMEOUT_MS: "-1" })).toThrow(
      SkeinConfigError,
    );
  });
});
