// The two commands want opposite defaults, and the env var has to reach a container that only ever runs
// `skein start`. Asserted against an injected env so the tests don't depend on the developer's shell.

import { describe, expect, it } from "vitest";

import { resolveRequestLog } from "./request-log.js";

describe("resolveRequestLog", () => {
  it("uses the command's default when nothing is set", () => {
    expect(resolveRequestLog(undefined, true, {})).toBe(true);
    expect(resolveRequestLog(undefined, false, {})).toBe(false);
  });

  it("reads SKEIN_REQUEST_LOG, accepting either spelling", () => {
    expect(resolveRequestLog(undefined, false, { SKEIN_REQUEST_LOG: "true" })).toBe(true);
    expect(resolveRequestLog(undefined, false, { SKEIN_REQUEST_LOG: "1" })).toBe(true);
    expect(resolveRequestLog(undefined, true, { SKEIN_REQUEST_LOG: "false" })).toBe(false);
    expect(resolveRequestLog(undefined, true, { SKEIN_REQUEST_LOG: "0" })).toBe(false);
    expect(resolveRequestLog(undefined, true, { SKEIN_REQUEST_LOG: " FALSE " })).toBe(false);
  });

  it("lets an explicit flag win over the environment", () => {
    expect(resolveRequestLog(false, true, { SKEIN_REQUEST_LOG: "true" })).toBe(false);
    expect(resolveRequestLog(true, false, { SKEIN_REQUEST_LOG: "false" })).toBe(true);
  });

  // Unlike a pool size or a timeout, a bad value here cannot corrupt anything — refusing to boot a
  // production server over a logging preference would be the more damaging failure.
  it("falls back to the default on a malformed value rather than throwing", () => {
    expect(resolveRequestLog(undefined, true, { SKEIN_REQUEST_LOG: "yes" })).toBe(true);
    expect(resolveRequestLog(undefined, false, { SKEIN_REQUEST_LOG: "" })).toBe(false);
  });
});
