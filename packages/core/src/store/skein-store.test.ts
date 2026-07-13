import { describe, expect, it } from "vitest";

import { isTerminalRunStatus, TERMINAL_RUN_STATUSES } from "./skein-store.js";

describe("isTerminalRunStatus", () => {
  it("treats success/error/timeout as terminal", () => {
    for (const status of TERMINAL_RUN_STATUSES) {
      expect(isTerminalRunStatus(status)).toBe(true);
    }
  });

  it("treats in-flight statuses as non-terminal (they still hold the thread)", () => {
    expect(isTerminalRunStatus("pending")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("interrupted")).toBe(false);
  });
});
