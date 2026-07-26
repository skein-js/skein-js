// Assertions are on plain text: tests run non-TTY, so `colorEnabled` is false and no ANSI codes are
// emitted. That is deliberate — the failure block has to be legible in exactly that mode, since it
// is also the mode of every piped log and CI run.

import { RUN_FAILURE_REPORT_KIND, type RunFailureReport } from "@skein-js/agent-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDevLogger } from "./dev-logger.js";

/** Capture what the logger wrote to a given console method. */
function capture(method: "log" | "warn" | "error") {
  const lines: string[] = [];
  const spy = vi.spyOn(console, method).mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return {
    lines,
    spy,
    get output() {
      return lines.join("\n");
    },
  };
}

function report(over: Partial<RunFailureReport> = {}): RunFailureReport {
  return {
    kind: RUN_FAILURE_REPORT_KIND,
    runId: "7f3a1c2e",
    threadId: "9a7f0b31",
    assistantId: "research_agent",
    failingNodes: ["call_model"],
    error: new Error("429 rate limit exceeded"),
    wireError: { error: "Error", name: "Error", message: "429 rate limit exceeded" },
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createDevLogger — hostile meta", () => {
  it("never throws while rendering, whatever the meta holds", () => {
    // This runs on the path that already went wrong; throwing here loses both the original failure
    // and the report of it.
    const logger = createDevLogger();
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const hostile = {
      get boom(): string {
        throw new Error("nope");
      },
    };
    const unstringifiable = Object.create(null) as Record<string, unknown>;
    unstringifiable.self = unstringifiable;

    expect(() => logger.info("summary", cyclic)).not.toThrow();
    expect(() => logger.info("summary", hostile)).not.toThrow();
    expect(() => logger.info("summary", { nested: unstringifiable })).not.toThrow();
  });
});

describe("createDevLogger", () => {
  it("renders a normal info line with its message unchanged", () => {
    const captured = capture("log");
    createDevLogger().info("Server running at http://127.0.0.1:2024");
    expect(captured.output).toBe("info: Server running at http://127.0.0.1:2024");
  });

  it("renders an object meta as a compact key=value block", () => {
    const captured = capture("log");
    createDevLogger().info("Background run succeeded", { run_id: "r1", run_exec_ms: 12 });
    expect(captured.output).toContain("run_id=r1  run_exec_ms=12");
  });

  it("renders a bare Error meta as its stack plus cause chain", () => {
    // The pre-existing fallback path — everything that isn't a run-failure report still lands here.
    const captured = capture("error");
    createDevLogger().error(
      'graph "agent" failed to load',
      new Error("Failed to import graph module.", { cause: new Error("ENOENT") }),
    );
    expect(captured.output).toContain("Error: Failed to import graph module.");
    expect(captured.output).toContain("caused by: Error: ENOENT");
  });
});

describe("the graph-failure block", () => {
  it("fences the failure with text rules and blank lines, not color alone", () => {
    const captured = capture("error");
    createDevLogger().error("Graph run failed: 429 rate limit exceeded", report());

    expect(captured.output).toContain("GRAPH RUN FAILED");
    expect(captured.output).toContain("─");
    // A leading blank line is what actually stops a crash scrolling past among request logs.
    expect(captured.output).toMatch(/\n\s*\n\s+─+ GRAPH RUN FAILED/);
  });

  it("names the run, assistant, thread, and the node that threw", () => {
    const captured = capture("error");
    createDevLogger().error("Graph run failed: boom", report());

    expect(captured.output).toContain("run       7f3a1c2e");
    expect(captured.output).toContain("assistant research_agent");
    expect(captured.output).toContain("thread    9a7f0b31");
    expect(captured.output).toContain("node      call_model");
  });

  it("omits the node row entirely when LangGraph could not identify one", () => {
    const captured = capture("error");
    createDevLogger().error("Graph run failed: boom", report({ failingNodes: [] }));

    expect(captured.output).toContain("assistant research_agent");
    expect(captured.output).not.toContain("node ");
  });

  it("lists every node when a superstep failed in more than one", () => {
    const captured = capture("error");
    createDevLogger().error(
      "Graph run failed: boom",
      report({ failingNodes: ["call_model", "search"] }),
    );
    expect(captured.output).toContain("node      call_model, search");
  });

  it("prints the stack and the caused-by chain", () => {
    const captured = capture("error");
    createDevLogger().error(
      "Graph run failed: model call failed",
      report({
        error: new Error("model call failed", { cause: new Error("429 rate limit") }),
      }),
    );

    expect(captured.output).toContain("Error: model call failed");
    expect(captured.output).toContain("caused by: Error: 429 rate limit");
  });

  it("still renders when the stack names no readable source file", () => {
    // A failure to *illustrate* a failure must never become a failure of its own.
    const error = new Error("boom");
    error.stack = "Error: boom\n    at /definitely/not/a/real/file.ts:42:11";
    const captured = capture("error");

    expect(() =>
      createDevLogger().error("Graph run failed: boom", report({ error })),
    ).not.toThrow();
    expect(captured.output).toContain("GRAPH RUN FAILED");
  });

  it("includes a code frame pointing at the line that threw", () => {
    // Throw from this very file, so the stack names a source we know exists on disk.
    const thrown = new Error("boom from this test file");
    const captured = capture("error");
    createDevLogger().error("Graph run failed: boom", report({ error: thrown }));

    // The caret line of a rendered frame; proves the source was found, read, and excerpted.
    expect(captured.output).toMatch(/\n\s*\|\s*\^/);
    expect(captured.output).toContain("const thrown = new Error(");
  });
});
