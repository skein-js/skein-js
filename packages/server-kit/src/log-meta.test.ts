// `formatLogMeta` is what a *line-oriented* logger shows a reader when a run fails, so these assert
// the parts that are load-bearing for debugging: the failing node, the stack, and the `cause` chain.
// It must also never throw — it runs on the path that already went wrong, and a logger that crashes
// while reporting a crash loses both failures.

import { RUN_FAILURE_REPORT_KIND, type RunFailureReport } from "@skein-js/agent-protocol";
import { describe, expect, it } from "vitest";

import { formatLogMeta } from "./log-meta.js";

function report(overrides: Partial<RunFailureReport> = {}): RunFailureReport {
  const error = new Error("graph exploded");
  return {
    kind: RUN_FAILURE_REPORT_KIND,
    runId: "run-1",
    threadId: "thread-1",
    assistantId: "assistant-1",
    failingNodes: ["research"],
    error,
    wireError: { message: "graph exploded", name: "Error" },
    ...overrides,
  } as RunFailureReport;
}

describe("formatLogMeta", () => {
  it("returns nothing for absent meta, so callers can append unconditionally", () => {
    expect(formatLogMeta(undefined)).toBe("");
    expect(formatLogMeta(null)).toBe("");
  });

  it("renders a failed run's identity and stack", () => {
    const rendered = formatLogMeta(report());
    expect(rendered).toContain("run=run-1");
    expect(rendered).toContain("thread=thread-1");
    expect(rendered).toContain("assistant=assistant-1");
    expect(rendered).toContain("node=research");
    expect(rendered).toContain("Error: graph exploded");
    expect(rendered).toContain("    at ");
  });

  it("omits the node row when LangGraph named no node, rather than guessing", () => {
    expect(formatLogMeta(report({ failingNodes: [] }))).not.toContain("node=");
  });

  it("follows an error's cause chain, where the real reason usually lives", () => {
    const error = new Error("outer", { cause: new Error("the actual reason") });
    expect(formatLogMeta(error)).toContain("the actual reason");
  });

  it("renders the background-run summary as key=value", () => {
    expect(formatLogMeta({ run_id: "r1", run_exec_ms: 42 })).toBe("run_id=r1 run_exec_ms=42");
  });

  it("survives cycles and throwing getters", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => formatLogMeta(cyclic)).not.toThrow();

    const hostile = {
      get boom(): string {
        throw new Error("nope");
      },
    };
    expect(() => formatLogMeta({ nested: hostile })).not.toThrow();
    // The top-level case too: `Object.entries` invokes getters, so this throws a level earlier than
    // the nested one and skips the `safeStringify` guard entirely.
    expect(() => formatLogMeta(hostile)).not.toThrow();
  });

  it("survives values that cannot even be stringified", () => {
    // A null-prototype cyclic object: JSON.stringify rejects the cycle, and the `String()` fallback
    // has no `Symbol.toPrimitive`/`toString` to convert through.
    const hostile = Object.create(null) as Record<string, unknown>;
    hostile.self = hostile;
    expect(() => formatLogMeta({ nested: hostile })).not.toThrow();
    expect(() => formatLogMeta(hostile)).not.toThrow();
  });

  it("stringifies a primitive rather than dropping it", () => {
    expect(formatLogMeta("plain detail")).toBe("plain detail");
    expect(formatLogMeta(42)).toBe("42");
  });
});
