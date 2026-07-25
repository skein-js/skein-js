import { DEFAULT_SHUTDOWN_GRACE_MS } from "@skein-js/agent-protocol";
import { SkeinConfigError } from "@skein-js/config";
import { describe, expect, it } from "vitest";

import { resolveShutdownGraceMs } from "./shutdown-grace.js";

describe("resolveShutdownGraceMs", () => {
  it("defaults to a window that fits inside the tightest common stop signal", () => {
    expect(resolveShutdownGraceMs(undefined, {})).toBe(DEFAULT_SHUTDOWN_GRACE_MS);
    // 5s of drain plus the host's force-exit buffer has to stay under the ~10s a container platform
    // typically allows between SIGTERM and SIGKILL.
    expect(DEFAULT_SHUTDOWN_GRACE_MS).toBe(5000);
  });

  it("reads SKEIN_SHUTDOWN_GRACE_MS", () => {
    expect(resolveShutdownGraceMs(undefined, { SKEIN_SHUTDOWN_GRACE_MS: "20000" })).toBe(20000);
  });

  it("treats a blank env value as unset rather than as zero", () => {
    // `Number("")` is 0, which would silently mean "abort in-flight runs immediately".
    expect(resolveShutdownGraceMs(undefined, { SKEIN_SHUTDOWN_GRACE_MS: "  " })).toBe(
      DEFAULT_SHUTDOWN_GRACE_MS,
    );
    expect(resolveShutdownGraceMs(undefined, { SKEIN_SHUTDOWN_GRACE_MS: "" })).toBe(
      DEFAULT_SHUTDOWN_GRACE_MS,
    );
  });

  it("accepts zero — abort immediately and rely on queue redelivery", () => {
    expect(resolveShutdownGraceMs(undefined, { SKEIN_SHUTDOWN_GRACE_MS: "0" })).toBe(0);
    expect(resolveShutdownGraceMs(0, {})).toBe(0);
  });

  it("lets an explicit option win over the environment", () => {
    expect(resolveShutdownGraceMs(1000, { SKEIN_SHUTDOWN_GRACE_MS: "20000" })).toBe(1000);
  });

  // The non-obvious rule, matching resolveRunConcurrency: both sources must agree, so a typo in a
  // deployment's environment can't hide behind an explicit option that happens to be set.
  it("still rejects an invalid env value when an explicit option is given", () => {
    expect(() => resolveShutdownGraceMs(1000, { SKEIN_SHUTDOWN_GRACE_MS: "10s" })).toThrow(
      SkeinConfigError,
    );
  });

  it.each(["10s", "-1", "1.5", "soon"])("rejects SKEIN_SHUTDOWN_GRACE_MS=%s", (raw) => {
    expect(() => resolveShutdownGraceMs(undefined, { SKEIN_SHUTDOWN_GRACE_MS: raw })).toThrow(
      SkeinConfigError,
    );
  });

  it("names the offending variable in the error", () => {
    expect(() => resolveShutdownGraceMs(undefined, { SKEIN_SHUTDOWN_GRACE_MS: "-1" })).toThrow(
      /SKEIN_SHUTDOWN_GRACE_MS must be a non-negative integer in milliseconds \(got "-1"\)/,
    );
  });

  it.each([-1, 1.5])("rejects an explicit shutdownGraceMs of %s", (explicit) => {
    expect(() => resolveShutdownGraceMs(explicit, {})).toThrow(/worker\.shutdownGraceMs/);
  });
});
