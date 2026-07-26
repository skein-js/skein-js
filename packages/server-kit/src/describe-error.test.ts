import { describe, expect, it } from "vitest";

import { describeError } from "./describe-error.js";

describe("describeError", () => {
  it("prefers the stack, which already carries the message", () => {
    expect(describeError(new Error("boom"))).toContain("Error: boom");
    expect(describeError(new Error("boom"))).toContain("    at ");
  });

  it("appends the cause chain, so a wrapped error keeps its origin", () => {
    // This is the case the boot and reload paths used to lose: a SkeinConfigError's `cause` is the
    // real import failure, and printing only `.message` said nothing about it.
    const wrapped = new Error("Failed to import graph module.", {
      cause: new Error("ENOENT: no such file", { cause: new Error("root") }),
    });
    const described = describeError(wrapped);

    expect(described).toContain("Failed to import graph module.");
    expect(described).toContain("caused by: Error: ENOENT: no such file");
    expect(described).toContain("caused by: Error: root");
  });

  it("appends structured details when the error carries any", () => {
    const withDetails = Object.assign(new Error("Invalid langgraph.json."), {
      details: [{ path: ["graphs"], message: "Required" }],
    });
    expect(describeError(withDetails)).toContain(
      'details: [{"path":["graphs"],"message":"Required"}]',
    );
  });

  it("falls back to name: message when there is no stack", () => {
    const stackless = new Error("boom");
    stackless.stack = undefined;
    expect(describeError(stackless)).toBe("Error: boom");
  });

  it("renders non-errors legibly", () => {
    expect(describeError("boom")).toBe("boom");
    expect(describeError(42)).toBe("42");
    expect(describeError(null)).toBe("null");
    expect(describeError({ code: 429 })).toBe('{"code":429}');
  });

  it("terminates on a cause chain that loops", () => {
    const first = new Error("first");
    const second = new Error("second");
    (first as { cause?: unknown }).cause = second;
    (second as { cause?: unknown }).cause = first;

    const described = describeError(first);
    expect(described).toContain("first");
    expect(described).toContain("second");
    // Two links, not an infinite unrolling.
    expect(described.match(/caused by:/g)).toHaveLength(2);
  });

  it("survives a throwing getter", () => {
    const thrown = new Error("boom");
    Object.defineProperty(thrown, "cause", {
      get() {
        throw new Error("getter exploded");
      },
    });
    expect(() => describeError(thrown)).not.toThrow();
  });
});
