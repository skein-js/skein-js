import path from "node:path";

import { describe, expect, it } from "vitest";

import { codeFrameForStack, findUserFrame, renderCodeFrame } from "./code-frame.js";

const THIS_FILE = new URL(import.meta.url).pathname;
const THIS_DIR = path.dirname(THIS_FILE);

describe("findUserFrame", () => {
  it("picks the first frame in the user's own code", () => {
    const frames = [
      "    at node:internal/process/task_queues:95:5",
      "    at RunnableSequence.invoke (/app/node_modules/@langchain/core/dist/runnable.js:12:9)",
      "    at callModel (/app/src/graph.ts:42:11)",
      "    at researchNode (/app/src/nodes.ts:8:3)",
    ].join("\n");

    expect(findUserFrame(frames)).toEqual({ file: "/app/src/graph.ts", line: 42, column: 11 });
  });

  it("reads the bare `at /path:line:col` form too", () => {
    expect(findUserFrame("    at /app/src/graph.ts:7:2")).toEqual({
      file: "/app/src/graph.ts",
      line: 7,
      column: 2,
    });
  });

  it("normalizes a file: URL, which is what source-mapped frames use", () => {
    expect(findUserFrame("    at fn (file:///app/src/graph.ts:3:1)")?.file).toBe(
      "/app/src/graph.ts",
    );
  });

  it("gives up rather than guessing when every frame is framework code", () => {
    const frames = [
      "    at node:internal/x:1:1",
      "    at /app/node_modules/@langchain/langgraph/dist/pregel/runner.js:79:15",
    ].join("\n");

    expect(findUserFrame(frames)).toBeUndefined();
    expect(findUserFrame(undefined)).toBeUndefined();
    expect(findUserFrame("")).toBeUndefined();
  });
});

describe("renderCodeFrame", () => {
  it("marks the offending line and points a caret at the column", () => {
    // Rendered against this very file, so the excerpt is real rather than mocked.
    const frame = renderCodeFrame({ file: THIS_FILE, line: 1, column: 1 }, THIS_DIR);

    expect(frame).toContain('> 1 | import path from "node:path";');
    expect(frame).toMatch(/\|\s*\^/);
  });

  it("refuses to read a file outside the source root", () => {
    // The containment check must fire before the read, so an existing, readable file still yields
    // nothing when it sits outside the project.
    expect(renderCodeFrame({ file: "/etc/hosts", line: 1, column: 1 }, THIS_DIR)).toBeUndefined();
    expect(
      renderCodeFrame({ file: `${THIS_DIR}/../../../package.json`, line: 1, column: 1 }, THIS_DIR),
    ).toBeUndefined();
  });

  it("returns undefined instead of throwing when the file cannot be read", () => {
    expect(
      renderCodeFrame({ file: `${THIS_DIR}/no-such-file.ts`, line: 1, column: 1 }, THIS_DIR),
    ).toBeUndefined();
  });

  it("returns undefined when the line is outside the file", () => {
    expect(
      renderCodeFrame({ file: THIS_FILE, line: 100_000, column: 1 }, THIS_DIR),
    ).toBeUndefined();
    expect(renderCodeFrame({ file: THIS_FILE, line: 0, column: 1 }, THIS_DIR)).toBeUndefined();
  });
});

describe("codeFrameForStack", () => {
  it("produces a frame for a real error thrown inside the source root", () => {
    expect(codeFrameForStack(new Error("boom"), THIS_DIR)).toContain("|");
  });

  it("produces nothing when the stack is unusable", () => {
    const frameworkOnly = new Error("boom");
    frameworkOnly.stack = "Error: boom\n    at node:internal/x:1:1";
    expect(codeFrameForStack(frameworkOnly, THIS_DIR)).toBeUndefined();

    const stackless = new Error("boom");
    stackless.stack = undefined;
    expect(codeFrameForStack(stackless, THIS_DIR)).toBeUndefined();
  });

  // An error message is routinely attacker-influenced — a raw LLM response, a fetched document, or
  // just `throw new Error(\`bad mode: ${input.mode}\`)` over client-supplied input. `Error.stack` is
  // `${name}: ${message}` followed by the frames, so a newline in the message renders a line that
  // parses exactly like a frame *and* precedes every genuine one. Reading the file it names would be
  // an arbitrary-file-read primitive driven by request input.
  describe("stack-frame injection through the message", () => {
    /** A realistic V8 stack: the header, then frames that are all framework code. */
    function withInjectedMessage(name: string, message: string): Error {
      const error = new Error(message);
      error.name = name;
      error.stack = [
        `${name}: ${message}`,
        "    at /app/node_modules/@langchain/langgraph/dist/pregel/runner.js:79:15",
        "    at node:internal/process/task_queues:95:5",
      ].join("\n");
      return error;
    }

    it("ignores a fake frame planted in the message", () => {
      const injected = withInjectedMessage("Error", "bad input\n    at /etc/passwd:1:1");

      // The old behavior: parsing the whole stack picks the planted path, ahead of every real frame.
      expect(findUserFrame(injected.stack)).toEqual({ file: "/etc/passwd", line: 1, column: 1 });
      // The fix: parsing only the frame region finds nothing readable, even with an unbounded root.
      expect(codeFrameForStack(injected, "/")).toBeUndefined();
    });

    it("ignores a fake frame buried in a multi-line message", () => {
      // The shape LangChain's OutputParserException produces: raw model text interpolated verbatim.
      const injected = withInjectedMessage(
        "OutputParserException",
        'Failed to parse. Text: "here is my answer\n    at /etc/passwd:1:1\ndone". Error: SyntaxError',
      );

      expect(findUserFrame(injected.stack)?.file).toBe("/etc/passwd");
      expect(codeFrameForStack(injected, "/")).toBeUndefined();
    });

    it("still finds the genuine frame when the message also contains one", () => {
      // Skipping the header must not cost the real frame beneath it.
      const thrown = new Error("bad input\n    at /etc/passwd:1:1");
      const frame = codeFrameForStack(thrown, THIS_DIR);

      expect(frame).toContain("const thrown = new Error(");
    });

    it("skips the frame entirely for a stack whose header it cannot account for", () => {
      // A hand-set or non-V8 stack: guessing where the frames begin risks parsing the message, so
      // the frame is dropped rather than derived from an assumption.
      const odd = new Error("boom");
      odd.stack = "    at /etc/passwd:1:1";

      expect(codeFrameForStack(odd, "/")).toBeUndefined();
    });
  });
});
