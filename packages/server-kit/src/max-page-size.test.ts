import { SkeinConfigError } from "@skein-js/config";
import { DEFAULT_MAX_PAGE_SIZE } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { resolveMaxPageSize } from "./max-page-size.js";

describe("resolveMaxPageSize", () => {
  it("defaults when neither an explicit value nor the environment is set", () => {
    expect(resolveMaxPageSize(undefined, {})).toBe(DEFAULT_MAX_PAGE_SIZE);
  });

  it("reads SKEIN_MAX_PAGE_SIZE", () => {
    expect(resolveMaxPageSize(undefined, { SKEIN_MAX_PAGE_SIZE: "250" })).toBe(250);
  });

  it("treats a blank SKEIN_MAX_PAGE_SIZE as unset", () => {
    expect(resolveMaxPageSize(undefined, { SKEIN_MAX_PAGE_SIZE: "  " })).toBe(
      DEFAULT_MAX_PAGE_SIZE,
    );
  });

  it("prefers an explicit value over the environment", () => {
    expect(resolveMaxPageSize(20, { SKEIN_MAX_PAGE_SIZE: "250" })).toBe(20);
  });

  it("throws on a malformed SKEIN_MAX_PAGE_SIZE", () => {
    expect(() => resolveMaxPageSize(undefined, { SKEIN_MAX_PAGE_SIZE: "many" })).toThrow(
      SkeinConfigError,
    );
    expect(() => resolveMaxPageSize(undefined, { SKEIN_MAX_PAGE_SIZE: "0" })).toThrow(
      /must be a positive integer/,
    );
  });

  it("validates an explicit value, naming the option in the error", () => {
    expect(() => resolveMaxPageSize(0, {})).toThrow(/store\.maxPageSize/);
    expect(() => resolveMaxPageSize(1.5, {})).toThrow(SkeinConfigError);
  });

  // "1e21" parses as an integer, so `Number.isInteger` let it through — and it then reaches Postgres as
  // "1e+21", failing every single query after a clean boot.
  it("rejects a value past the safe integer range rather than failing later per query", () => {
    expect(() => resolveMaxPageSize(undefined, { SKEIN_MAX_PAGE_SIZE: "1e21" })).toThrow(
      SkeinConfigError,
    );
    expect(() => resolveMaxPageSize(1e21, {})).toThrow(SkeinConfigError);
  });

  // A deployment that sets a bad value but also passes the option explicitly still fails at boot,
  // rather than running with a knob that silently does nothing.
  it("validates the environment even when an explicit value is given", () => {
    expect(() => resolveMaxPageSize(20, { SKEIN_MAX_PAGE_SIZE: "-5" })).toThrow(SkeinConfigError);
  });
});
