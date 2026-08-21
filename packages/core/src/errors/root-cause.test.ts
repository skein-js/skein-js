import { describe, expect, it } from "vitest";

import { rootCause, rootCauseMessage } from "./root-cause.js";

describe("rootCause", () => {
  it("returns the error itself when nothing wraps it", () => {
    const error = new Error("boom");
    expect(rootCause(error)).toBe(error);
  });

  it("descends to the deepest link of a chain", () => {
    const root = new Error("GOOGLE_API_KEY is not set");
    const wrapped = new Error("Failed to import graph module.", { cause: root });
    expect(rootCause(wrapped)).toBe(root);
  });

  it("stops at the depth cap rather than walking forever", () => {
    // Ten links, cap is five — the result is a link, never undefined.
    let error = new Error("depth-10");
    for (let level = 9; level >= 0; level -= 1) {
      error = new Error(`depth-${level}`, { cause: error });
    }
    expect(rootCause(error)).toBeInstanceOf(Error);
    expect((rootCause(error) as Error).message).toBe("depth-5");
  });

  it("terminates on a chain that loops back on itself", () => {
    const first = new Error("first") as Error & { cause?: unknown };
    const second = new Error("second", { cause: first }) as Error & { cause?: unknown };
    first.cause = second;
    expect(rootCause(first)).toBeInstanceOf(Error);
  });

  it("survives a cause defined by a throwing getter", () => {
    const hostile = new Error("outer");
    Object.defineProperty(hostile, "cause", {
      get() {
        throw new Error("nope");
      },
    });
    expect(rootCause(hostile)).toBe(hostile);
  });

  it("returns a non-Error throw unchanged", () => {
    expect(rootCause("boom")).toBe("boom");
    expect(rootCause(null)).toBe(null);
  });
});

describe("rootCauseMessage", () => {
  it("reports the root's message, not the wrapper's", () => {
    const wrapped = new Error('Failed to import graph module "agent-graph.ts".', {
      cause: new Error("GOOGLE_API_KEY is not set"),
    });
    expect(rootCauseMessage(wrapped)).toBe("GOOGLE_API_KEY is not set");
  });

  it("never comes back blank", () => {
    expect(rootCauseMessage(new Error(""))).toBe("Error");
    expect(rootCauseMessage("boom")).toBe("boom");
    expect(rootCauseMessage(42)).toBe("42");
    expect(rootCauseMessage(undefined)).toBe("undefined");
  });
});
