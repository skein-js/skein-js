import { describe, expect, it } from "vitest";

import { isSkeinHttpError, SkeinHttpError } from "./skein-http-error.js";

describe("SkeinHttpError", () => {
  it("carries the status and message", () => {
    const err = new SkeinHttpError(418, "teapot");
    expect(err.status).toBe(418);
    expect(err.message).toBe("teapot");
    expect(err.name).toBe("SkeinHttpError");
    expect(err).toBeInstanceOf(Error);
  });

  it("carries optional code and details", () => {
    const err = new SkeinHttpError(400, "bad", { code: "invalid", details: { field: "x" } });
    expect(err.code).toBe("invalid");
    expect(err.details).toEqual({ field: "x" });
  });

  it("preserves the cause when provided", () => {
    const cause = new Error("root");
    expect(new SkeinHttpError(500, "boom", { cause }).cause).toBe(cause);
  });

  it("exposes factories for the common statuses", () => {
    expect(SkeinHttpError.badRequest("x").status).toBe(400);
    expect(SkeinHttpError.notFound("x").status).toBe(404);
    expect(SkeinHttpError.conflict("x").status).toBe(409);
  });

  it("narrows unknown values with the type guard", () => {
    expect(isSkeinHttpError(SkeinHttpError.notFound("x"))).toBe(true);
    expect(isSkeinHttpError(new Error("plain"))).toBe(false);
    expect(isSkeinHttpError("nope")).toBe(false);
  });
});
