import { describe, expect, it } from "vitest";

import {
  INFLIGHT_RUN_STATUSES,
  isTerminalRunStatus,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
} from "./skein-store.js";

describe("isTerminalRunStatus", () => {
  it("treats success/error/timeout/interrupted as terminal", () => {
    for (const status of TERMINAL_RUN_STATUSES) {
      expect(isTerminalRunStatus(status)).toBe(true);
    }
  });

  it("treats an interrupted run as terminal (it yields the thread; resume is a fresh run)", () => {
    // Aligns with @langchain/langgraph-api, whose inflight check is `pending | running` only.
    expect(isTerminalRunStatus("interrupted")).toBe(true);
  });

  it("treats only pending/running as inflight (non-terminal)", () => {
    expect(isTerminalRunStatus("pending")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
  });
});

describe("INFLIGHT_RUN_STATUSES", () => {
  it("is exactly the complement of TERMINAL_RUN_STATUSES", () => {
    // The two lists are stated separately so a SQL driver can filter *positively* (a negated,
    // parameterized filter cannot use a partial index — see the constant's docstring). That only holds
    // while they stay complements, and nothing else would notice if they drifted: the query would
    // silently return a different set of runs than `isTerminalRunStatus` considers inflight.
    for (const status of INFLIGHT_RUN_STATUSES) {
      expect(isTerminalRunStatus(status)).toBe(false);
    }
    expect([...INFLIGHT_RUN_STATUSES, ...TERMINAL_RUN_STATUSES].sort()).toEqual(
      [...RUN_STATUSES].sort(),
    );
  });
});
