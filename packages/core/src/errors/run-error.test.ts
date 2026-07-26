import { describe, expect, it } from "vitest";

import { toRunError } from "./run-error.js";

describe("toRunError", () => {
  it("describes a plain error with the platform's field names", () => {
    expect(toRunError(new TypeError("boom"))).toEqual({
      error: "TypeError",
      name: "TypeError",
      message: "boom",
    });
  });

  it("always carries `name` and `error` with the same value", () => {
    // The SDK's `StreamError` reads `data.name ?? data.error`; the platform emits only `error`.
    const described = toRunError(new RangeError("out of range"));
    expect(described.name).toBe(described.error);
  });

  it("stringifies a thrown primitive without quoting it", () => {
    expect(toRunError("boom").message).toBe("boom");
    expect(toRunError(42).message).toBe("42");
    expect(toRunError(null).message).toBe("null");
    expect(toRunError(undefined).message).toBe("undefined");
  });

  it("renders a thrown plain object as JSON, not [object Object]", () => {
    expect(toRunError({ code: 429, detail: "rate limited" }).message).toBe(
      '{"code":429,"detail":"rate limited"}',
    );
  });

  it("names a non-error throw `Error`", () => {
    expect(toRunError("boom")).toEqual({ error: "Error", name: "Error", message: "boom" });
  });

  it("walks the cause chain", () => {
    const thrown = new Error("model call failed", {
      cause: new Error("429 rate limit", { cause: new TypeError("root") }),
    });
    expect(toRunError(thrown)).toEqual({
      error: "Error",
      name: "Error",
      message: "model call failed",
      cause: {
        error: "Error",
        name: "Error",
        message: "429 rate limit",
        cause: { error: "TypeError", name: "TypeError", message: "root" },
      },
    });
  });

  it("terminates on a cause chain that loops back on itself", () => {
    const first = new Error("first");
    const second = new Error("second");
    (first as { cause?: unknown }).cause = second;
    (second as { cause?: unknown }).cause = first;

    const described = toRunError(first);
    expect(described.message).toBe("first");
    expect(described.cause?.message).toBe("second");
    // The loop closes here rather than recursing forever.
    expect(described.cause?.cause?.cause).toBeUndefined();
  });

  it("truncates a cause chain deeper than five levels", () => {
    let thrown = new Error("level-8");
    for (let level = 7; level >= 0; level -= 1) {
      thrown = new Error(`level-${level}`, { cause: thrown });
    }

    let described = toRunError(thrown);
    let depth = 0;
    while (described.cause) {
      described = described.cause;
      depth += 1;
    }
    expect(depth).toBe(5);
  });

  it("keeps an AggregateError's members, which carry the only useful messages", () => {
    // LangGraph throws one of these when several nodes fail in the same superstep.
    const thrown = new AggregateError(
      [new Error("node a failed"), new TypeError("node b failed")],
      "Multiple errors occurred during superstep 3",
    );
    const described = toRunError(thrown);
    expect(described.message).toBe("Multiple errors occurred during superstep 3");
    expect(described.errors).toEqual([
      { error: "Error", name: "Error", message: "node a failed" },
      { error: "TypeError", name: "TypeError", message: "node b failed" },
    ]);
  });

  it("caps an AggregateError at ten members", () => {
    const members = Array.from({ length: 200 }, (_unused, index) => new Error(`failure ${index}`));
    expect(toRunError(new AggregateError(members, "many")).errors).toHaveLength(10);
  });

  it("omits the stack unless asked", () => {
    expect(toRunError(new Error("boom")).stack).toBeUndefined();
    expect(toRunError(new Error("boom"), { includeStack: true }).stack).toContain("Error: boom");
  });

  it("omits the stack at every level of the chain, not just the top", () => {
    // A stack leaking through a `cause` while the top level hides it is the exact regression that
    // would defeat the point of gating stacks behind `exposeErrorStacks`.
    const thrown = new Error("outer", { cause: new Error("inner") });
    const described = toRunError(thrown);
    expect(described.stack).toBeUndefined();
    expect(described.cause?.stack).toBeUndefined();

    const withStacks = toRunError(thrown, { includeStack: true });
    expect(withStacks.stack).toBeDefined();
    expect(withStacks.cause?.stack).toBeDefined();
  });

  it("omits the stack inside an AggregateError's members too", () => {
    const thrown = new AggregateError([new Error("member")], "many");
    expect(toRunError(thrown).errors?.[0]?.stack).toBeUndefined();
    expect(toRunError(thrown, { includeStack: true }).errors?.[0]?.stack).toBeDefined();
  });

  it("survives a throwing getter rather than replacing the real error", () => {
    const thrown = new Error("boom");
    Object.defineProperty(thrown, "cause", {
      get() {
        throw new Error("getter exploded");
      },
    });
    expect(() => toRunError(thrown, { includeStack: true })).not.toThrow();
    expect(toRunError(thrown).message).toBe("boom");
  });

  it("survives a cyclic non-error throw", () => {
    const thrown: Record<string, unknown> = { code: 1 };
    thrown["self"] = thrown;
    expect(() => toRunError(thrown)).not.toThrow();
  });

  it("keeps a custom error's name", () => {
    class SkeinConfigError extends Error {
      constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "SkeinConfigError";
      }
    }
    const described = toRunError(
      new SkeinConfigError("Failed to import graph module.", { cause: new Error("ENOENT") }),
    );
    expect(described.error).toBe("SkeinConfigError");
    expect(described.cause?.message).toBe("ENOENT");
  });

  it("round-trips through JSON, so it survives both jsonb and SSE", () => {
    const described = toRunError(
      new AggregateError([new Error("a")], "many", { cause: new Error("root") }),
      { includeStack: true },
    );
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
  });
});
